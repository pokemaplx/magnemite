"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@magnemite/db";
import { requireOperator } from "@/lib/session";
import {
  type DeviceConfigPreview,
  type DeviceConfigPush,
  type MaintenanceResult,
  type RotomDeviceAction,
  hub,
} from "@/lib/hub";
import {
  planFromNames,
  planRename,
  type RenameOptions,
  type RenameTarget,
} from "@/lib/rename-pattern";
import type { ActionState } from "./rollouts";

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function setDeviceApproval(deviceId: string, approved: boolean): Promise<ActionState> {
  const user = await requireOperator();
  await prisma.device.update({ where: { id: deviceId }, data: { approved } });
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: approved ? "device.approve" : "device.unapprove",
      targetType: "Device",
      targetId: deviceId,
    },
  });

  // The other door into a group's join installs.
  //
  // A box that enrolled on a token without auto-approve was pending at the
  // time, so enrolment queued nothing -- a rollout skips an unapproved device.
  // This is the moment it becomes a target, and the only one left.
  //
  // Swallowed on purpose: the approval is done and recorded, and failing the
  // whole action because an install could not be queued would leave the
  // operator pressing a button that already worked.
  if (approved) {
    await hub.queueJoinInstalls(deviceId).catch(() => undefined);
  }

  revalidatePath("/");
  revalidatePath(`/devices/${deviceId}`);
  return { ok: true };
}

/**
 * Everywhere a device's name or group is rendered.
 *
 * `renameDevice` used to revalidate `/` and the device page only, so a renamed
 * box kept its old name on the manual deploy picker, the monitoring feed and
 * any open rollout until something else happened to invalidate them. The
 * dynamic form is the only option for a batch, where there is no single id.
 *
 * The group is shown on exactly the same pages, so a move needs the same list.
 */
function revalidateDeviceViews(): void {
  revalidatePath("/");
  revalidatePath("/manual");
  revalidatePath("/monitoring");
  revalidatePath("/devices/[id]", "page");
  revalidatePath("/rollouts/[id]", "page");
}

export async function renameDevice(deviceId: string, name: string): Promise<ActionState> {
  const user = await requireOperator();
  const trimmed = name.trim();
  if (!trimmed) return { error: "Name cannot be empty." };

  const before = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { name: true, serial: true },
  });
  if (!before) return { error: "That device is already gone." };

  await prisma.device.update({ where: { id: deviceId }, data: { name: trimmed } });

  // Logged like every other device action. Its absence was an outlier next to
  // `setDeviceApproval` and `deleteDevice`, and this row is the only place the
  // old name survives.
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "device.rename",
      targetType: "Device",
      targetId: deviceId,
      meta: { serial: before.serial, from: before.name, to: trimmed },
    },
  });

  revalidateDeviceViews();
  return { ok: true };
}

export async function setDeviceGroup(deviceId: string, groupId: string): Promise<ActionState> {
  return setDevicesGroup([deviceId], groupId);
}

/**
 * Move boxes between groups, one or forty.
 *
 * A group carries the pre/post-install hooks, the MITM config and the
 * concurrency cap, so this is not cosmetic: the same box installs differently
 * after the move. Hence the audit row naming every box it touched, and hence
 * the empty-string group id meaning "no group" rather than being rejected —
 * taking boxes out of a group is a real thing to want.
 *
 * Nothing is pushed to the boxes here. The new group's config reaches them the
 * next time something deploys to them, exactly as it does after editing the
 * group itself.
 */
export async function setDevicesGroup(
  deviceIds: string[],
  groupId: string,
): Promise<ActionState & { moved?: number }> {
  const user = await requireOperator();
  if (deviceIds.length === 0) return { error: "No boxes picked." };

  const target = groupId
    ? await prisma.deviceGroup.findUnique({ where: { id: groupId }, select: { name: true } })
    : null;
  if (groupId && !target) return { error: "That group is gone. Reload the page." };

  const devices = await prisma.device.findMany({
    where: { id: { in: deviceIds } },
    select: {
      id: true,
      serial: true,
      name: true,
      groupId: true,
      group: { select: { name: true } },
    },
  });
  if (devices.length !== deviceIds.length) {
    return { error: "A box in the selection is no longer there. Reload the page." };
  }

  // Only the ones that actually change, so the audit row is not full of boxes
  // that were already there and the count means what it says.
  const moved = devices.filter((device) => device.groupId !== (groupId || null));
  if (moved.length === 0) {
    return { ok: true, moved: 0, message: "Already there." };
  }

  await prisma.device.updateMany({
    where: { id: { in: moved.map((device) => device.id) } },
    data: { groupId: groupId || null },
  });

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "device.setGroup",
      targetType: "Device",
      // A single move keeps its device id, so the box's own audit view still
      // finds it; a batch has no one id to file it under.
      targetId: moved.length === 1 ? (moved[0]?.id ?? null) : null,
      meta: {
        to: target?.name ?? null,
        devices: devices.length,
        moved: moved.map((device) => ({
          serial: device.serial,
          name: device.name,
          from: device.group?.name ?? null,
        })),
      },
    },
  });

  revalidateDeviceViews();
  return {
    ok: true,
    moved: moved.length,
    message:
      moved.length === 1
        ? `Moved to ${target?.name ?? "no group"}.`
        : `Moved ${moved.length} boxes to ${target?.name ?? "no group"}.`,
  };
}

export async function rebootDevice(deviceId: string): Promise<ActionState> {
  const user = await requireOperator();
  try {
    await hub.rebootDevice(deviceId);
  } catch (err) {
    return { error: toMessage(err) };
  }
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "device.reboot",
      targetType: "Device",
      targetId: deviceId,
    },
  });
  return { ok: true, message: "Reboot sent." };
}

/** How many reboots are in flight at the hub at once. */
const REBOOT_CONCURRENCY = 8;

/**
 * Reboot a selection of boxes — the Fleet's bulk bar, and Shift+R on it.
 *
 * The hub only hands the message to a socket and answers, so each one is
 * quick; the cap is there so that three hundred picked boxes are not three
 * hundred requests landing on the hub in the same millisecond. A box with no
 * socket is counted rather than failing the rest — the selection is allowed to
 * hold boxes that went away while it was being made.
 *
 * Boxes only, and approved ones: the same boxes the selection can hold. A
 * machine is a Device too, and rebooting the VPS under twenty containers is not
 * something a list of TV boxes should be able to do by accident.
 */
export async function rebootDevices(deviceIds: string[]): Promise<ActionState & { sent?: number }> {
  const user = await requireOperator();
  if (deviceIds.length === 0) return { error: "No boxes picked." };

  const devices = await prisma.device.findMany({
    where: { id: { in: deviceIds }, kind: "BOX", approved: true },
    select: { id: true, serial: true, name: true },
  });
  if (devices.length === 0)
    return { error: "None of those boxes are here any more. Reload the page." };

  const outcomes = new Map<string, string>();
  let next = 0;
  async function worker() {
    while (next < devices.length) {
      const device = devices[next++]!;
      try {
        await hub.rebootDevice(device.id);
        outcomes.set(device.id, "sent");
      } catch (err) {
        const message = toMessage(err);
        // The hub's 409 for a box with no socket, which is a box that is
        // offline rather than a reboot that went wrong.
        outcomes.set(device.id, message === "device is offline" ? "offline" : message);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(REBOOT_CONCURRENCY, devices.length) }, () => worker()),
  );

  const sent = devices.filter((device) => outcomes.get(device.id) === "sent");
  const offline = devices.filter((device) => outcomes.get(device.id) === "offline").length;
  const failed = devices.filter(
    (device) => !["sent", "offline"].includes(outcomes.get(device.id) ?? ""),
  );

  if (sent.length > 0) {
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        userEmail: user.email,
        action: "device.reboot",
        targetType: "Device",
        // Same rule as a group move: one box keeps its id so its own audit view
        // still finds the row, a batch has no single id to file it under.
        targetId: devices.length === 1 ? (devices[0]?.id ?? null) : null,
        meta: {
          devices: devices.length,
          results: devices.map((device) => ({
            serial: device.serial,
            name: device.name,
            result: outcomes.get(device.id) ?? "skipped",
          })),
        },
      },
    });
  }

  const skipped = [
    offline > 0 ? `${offline} offline` : null,
    failed.length > 0 ? `${failed.length} failed (${outcomes.get(failed[0]!.id)})` : null,
  ]
    .filter(Boolean)
    .join(", ");

  if (sent.length === 0) return { error: `No box took the reboot — ${skipped}.` };
  return {
    ok: true,
    sent: sent.length,
    message:
      sent.length === devices.length
        ? `Reboot sent to ${sent.length} ${sent.length === 1 ? "box" : "boxes"}.`
        : `Reboot sent to ${sent.length} of ${devices.length} — ${skipped}.`,
  };
}

/**
 * Run a command on the box and return what it printed.
 *
 * This is a root shell on someone's living-room hardware, so it is operators
 * only and every invocation goes in the audit log with the command itself —
 * the same footing as the pre/post-install hooks, which have always been able
 * to run anything.
 */
export async function execOnDevice(
  deviceId: string,
  command: string,
): Promise<ActionState & { output?: string; failed?: boolean }> {
  const user = await requireOperator();
  const trimmed = command.trim();
  if (!trimmed) return { error: "Nothing to run." };

  let result: { ok: boolean; output: string; error: string | null };
  try {
    result = await hub.execOnDevice(deviceId, trimmed);
  } catch (err) {
    return { error: toMessage(err) };
  }

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "device.exec",
      targetType: "Device",
      targetId: deviceId,
      meta: { command: trimmed, ok: result.ok },
    },
  });

  return {
    ok: true,
    failed: !result.ok,
    output: result.output,
    message: result.ok ? "Command ran." : (result.error ?? "The command failed."),
  };
}

/**
 * What rewriting the box's MITM config would write.
 *
 * Operators only, like Execute itself: the rendered file is the MITM's
 * credentials, and the group form already keeps the template from a viewer.
 */
export async function previewDeviceConfig(
  deviceId: string,
): Promise<ActionState & { preview?: DeviceConfigPreview }> {
  await requireOperator();
  try {
    return { ok: true, preview: await hub.previewDeviceConfig(deviceId) };
  } catch (err) {
    return { error: toMessage(err) };
  }
}

/**
 * Write the MITM's config to the box and restart the MITM -- no install.
 *
 * `content` is sent only when somebody edited it; otherwise the hub writes the
 * group's own template, rendered for the box, which is the same file it would
 * have written with the next install.
 *
 * Audited like Execute, but with the path and the hash and never the content:
 * that is the MITM's credentials, and keeping them out of the audit log is
 * the reason this is not a command typed into Execute.
 */
export async function pushDeviceConfig(
  deviceId: string,
  content: string | null,
): Promise<ActionState & { result?: DeviceConfigPush }> {
  const user = await requireOperator();

  let result: DeviceConfigPush;
  try {
    result = await hub.pushDeviceConfig(deviceId, content);
  } catch (err) {
    return { error: toMessage(err) };
  }

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "device.config.push",
      targetType: "Device",
      targetId: deviceId,
      meta: {
        path: result.path,
        sha256: result.sha256,
        ok: result.ok,
        edited: content !== null,
        hookError: result.hookError,
      },
    },
  });

  return { ok: true, result };
}

/**
 * Collect the box's logs and hand back the bundle to download.
 *
 * The call blocks while the box zips and uploads — usually a few seconds — so
 * the caller gets either a bundle id it can send the browser to, or the reason
 * there is none. Nothing to poll.
 */
export async function collectDeviceLogs(
  deviceId: string,
): Promise<ActionState & { bundleId?: string }> {
  const user = await requireOperator();
  let bundleId: string;
  try {
    ({ bundleId } = await hub.collectDeviceLogs(deviceId, user.id));
  } catch (err) {
    return { error: toMessage(err) };
  }

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "device.logs",
      targetType: "Device",
      targetId: deviceId,
      meta: { bundleId },
    },
  });

  return { ok: true, bundleId };
}

/**
 * Take one screenshot and hand back its id to render.
 *
 * Blocks exactly like the log bundle above, for a few seconds at most, so the
 * dialog gets either an id to point an `<img>` at or the reason there is none.
 *
 * Audited with everything else a person does to a box, and that row matters
 * more here than it does for a log: this is a picture of somebody's living
 * room, and who looked is part of the answer to whether that was reasonable.
 */
export async function captureScreenshot(
  deviceId: string,
): Promise<ActionState & { screenshotId?: string }> {
  const user = await requireOperator();
  let screenshotId: string;
  try {
    ({ screenshotId } = await hub.captureScreenshot(deviceId, user.id));
  } catch (err) {
    return { error: toMessage(err) };
  }

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "device.screenshot",
      targetType: "Device",
      targetId: deviceId,
      meta: { screenshotId },
    },
  });

  return { ok: true, screenshotId };
}

/**
 * Park a box for a while, or put it back.
 *
 * `minutes` of 0 is the release. One action rather than two, because both
 * halves run the group's matching hook and neither makes sense alone.
 *
 * What comes back includes what happened to that hook, which the dialog says
 * out loud: "parked" that quietly meant "and the scanner is still running" is
 * a different thing to be holding than what was asked for.
 */
export async function setDeviceMaintenance(
  deviceId: string,
  minutes: number,
): Promise<ActionState & { until?: string | null; hookNote?: string | null }> {
  const user = await requireOperator();

  let result: MaintenanceResult;
  try {
    result = await hub.setDeviceMaintenance(deviceId, minutes, user.email);
  } catch (err) {
    return { error: toMessage(err) };
  }

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: minutes > 0 ? "device.maintenance.start" : "device.maintenance.end",
      targetType: "Device",
      targetId: deviceId,
      meta: {
        device: result.deviceName,
        minutes,
        until: result.until,
        hookRan: result.hook.ran,
        // The command itself, because "the hook failed" six weeks later is not
        // a question this row can answer without it.
        hookCommand: result.hook.command,
        hookError: result.hook.error,
      },
    },
  });

  // The badge shows up on the fleet table and on the device page, and a parked
  // box changes what the rollout forms will accept.
  revalidateDeviceViews();
  return {
    ok: true,
    until: result.until,
    hookNote: result.hook.error
      ? `The hook failed: ${result.hook.error}`
      : (result.hook.skipped ?? null),
  };
}

/**
 * Rotom-side control. `restart` is the useful one day to day: it kicks the
 * scanner app without rebooting the whole box.
 */
export async function rotomDeviceAction(
  deviceId: string,
  action: RotomDeviceAction,
): Promise<ActionState> {
  const user = await requireOperator();
  try {
    await hub.rotomDeviceAction(deviceId, action);
  } catch (err) {
    return { error: toMessage(err) };
  }
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: `rotom.${action}`,
      targetType: "Device",
      targetId: deviceId,
    },
  });
  revalidatePath(`/devices/${deviceId}`);
  return { ok: true, message: `Rotom: ${action} sent.` };
}

/**
 * Take a box out of Rotom's pool, or put it back.
 *
 * Its own action rather than `rotomDeviceAction("enable")` because it is the
 * one Rotom control with a state to be wrong about. Two things follow from
 * that:
 *
 *  - **A box already in the asked-for state is told, not poked.** Sending
 *    `enable` to an enabled box is a no-op that reads as a success, and the
 *    menu that offered it was working from a stored copy that may be a sync
 *    old.
 *  - **The answer is re-read from Rotom, not assumed.** Every other Rotom field
 *    on the page waits for the next sync; here that would mean the menu still
 *    saying "Disable" right after a disable, which is exactly the confusion the
 *    toggle exists to avoid. So this syncs and reports what Rotom now says —
 *    including when Rotom did not take it.
 */
export async function rotomSetEnabled(deviceId: string, next: boolean): Promise<ActionState> {
  const user = await requireOperator();
  const word = next ? "enabled" : "disabled";

  const before = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { rotomDeviceId: true, rotomEnabled: true },
  });
  if (!before?.rotomDeviceId) return { error: "This device is not matched to a Rotom device." };
  if (before.rotomEnabled === next) {
    return { ok: true, message: `Rotom already has this box ${word}.` };
  }

  try {
    await hub.rotomDeviceAction(deviceId, next ? "enable" : "disable");
  } catch (err) {
    return { error: toMessage(err) };
  }

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: `rotom.${next ? "enable" : "disable"}`,
      targetType: "Device",
      targetId: deviceId,
    },
  });

  // Best effort: a sync that fails leaves the page on the last known state,
  // which is the same place it would have been without asking.
  try {
    await hub.rotomSync();
  } catch {
    // Nothing to say about it here — the message below reports what is stored.
  }

  const after = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { rotomEnabled: true },
  });
  revalidatePath(`/devices/${deviceId}`);

  if (after?.rotomEnabled !== next) {
    return {
      ok: true,
      message: `Rotom took the request but still has this box ${after?.rotomEnabled ? "enabled" : "disabled"}.`,
    };
  }
  return { ok: true, message: `Rotom now has this box ${word}.` };
}

export async function syncRotom(): Promise<ActionState> {
  await requireOperator();
  try {
    const { seen, matched } = await hub.rotomSync();
    revalidatePath("/");
    return { ok: true, message: `Rotom knows ${seen} device(s); ${matched} matched.` };
  } catch (err) {
    return { error: toMessage(err) };
  }
}

/**
 * Removing a device drops its token, so the box goes quiet until it is
 * re-enrolled. Its job history goes with it.
 *
 * Boxes only. A machine deleted through here would cascade its `RedroidHost`
 * and instance rows away without any of the three things `deleteHost` does
 * first -- its containers would keep running, and `/etc/magnemite/host.json`
 * would still hold a serial whose row is gone, which is what stops the machine
 * from ever being added again. Not reachable from the UI, where the fleet
 * lists boxes and a machine's device page redirects to `/hosts`, but this is a
 * server action and therefore an endpoint.
 */
export async function deleteDevice(deviceId: string): Promise<ActionState> {
  const user = await requireOperator();
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) return { error: "Device not found." };
  if (device.kind === "HOST") {
    return { error: "That is a machine. Remove it from its own page, so its containers go too." };
  }

  await prisma.device.delete({ where: { id: deviceId } });
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "device.delete",
      targetType: "Device",
      targetId: deviceId,
      meta: { serial: device.serial, name: device.name },
    },
  });
  revalidatePath("/");
  return { ok: true };
}

// --- naming many boxes at once ---------------------------------------------

/**
 * Whether a group writes the device name into the config it puts on its boxes.
 *
 * Matched the way the hub's renderer does rather than with `includes`, because
 * it trims what is inside the braces and `{{ device.name }}` is legal there.
 */
const NAME_PLACEHOLDER = /\{\{\s*device\.name\s*\}\}/;

const RENAME_SELECT = {
  id: true,
  name: true,
  serial: true,
  model: true,
  manufacturer: true,
  createdAt: true,
  group: { select: { name: true, mitmConfigPath: true, mitmConfig: true } },
} as const;

type LoadedDevice = {
  id: string;
  name: string;
  serial: string;
  model: string | null;
  manufacturer: string | null;
  createdAt: Date;
  group: { name: string; mitmConfigPath: string | null; mitmConfig: string | null } | null;
};

/**
 * The group's config never leaves the server — only the one fact the preview
 * needs from it. It holds `authBearer` and `deviceAuthToken`, which is why the
 * settings page already blanks it for a VIEWER.
 */
function toTarget(device: LoadedDevice): RenameTarget {
  return {
    id: device.id,
    name: device.name,
    serial: device.serial,
    model: device.model,
    manufacturer: device.manufacturer,
    groupName: device.group?.name ?? null,
    createdAt: device.createdAt.toISOString(),
    configGoesStale: Boolean(
      device.group?.mitmConfig && NAME_PLACEHOLDER.test(device.group.mitmConfig),
    ),
  };
}

/**
 * Everything the rename dialog needs, in one round trip when it opens.
 *
 * The whole fleet's names come too, because a name that collides with a box
 * outside the selection is worth showing and the dialog cannot know about one.
 * Fetched on open rather than passed as props: the settings page has no device
 * list, and giving it one would ship every name on every settings visit.
 */
export async function loadRenameTargets(
  source: { deviceIds: string[] } | { groupId: string },
): Promise<ActionState & { targets?: RenameTarget[]; fleet?: { id: string; name: string }[] }> {
  await requireOperator();

  const where =
    "groupId" in source
      ? { kind: "BOX" as const, groupId: source.groupId, approved: true }
      : { kind: "BOX" as const, id: { in: source.deviceIds } };

  const [devices, fleet] = await Promise.all([
    prisma.device.findMany({ where, select: RENAME_SELECT }),
    // Boxes too: this is what the preview checks a proposed name against, and
    // a machine's name colliding with a box's is not the clash it warns about.
    prisma.device.findMany({ where: { kind: "BOX" }, select: { id: true, name: true } }),
  ]);
  if (devices.length === 0) return { error: "No boxes to rename." };

  // Put them back in the order the caller asked for, which for the fleet table
  // is the order on screen — the one the counter follows.
  const byId = new Map(devices.map((device) => [device.id, device]));
  const inOrder =
    "deviceIds" in source
      ? source.deviceIds.map((id) => byId.get(id)).filter((d): d is LoadedDevice => Boolean(d))
      : devices;

  return { ok: true, targets: inOrder.map(toTarget), fleet };
}

/**
 * Read the name each box's own MITM config already uses.
 *
 * For somebody pointing Magnemite at a fleet that is already running: the names
 * exist, on the boxes, and retyping them is work with a typo in it. The key to
 * read is not guessed — it is wherever that group's template puts
 * `{{device.name}}`, so the two always agree.
 *
 * The file holds `authBearer` and `deviceAuthToken`. Only the one string comes
 * back; the config body never reaches the browser, the log or the audit row.
 */
export async function readNamesFromBoxes(
  deviceIds: string[],
): Promise<ActionState & { found?: Record<string, { name: string | null; reason?: string }> }> {
  const user = await requireOperator();
  if (deviceIds.length === 0) return { error: "No boxes picked." };

  const devices = await prisma.device.findMany({
    where: { id: { in: deviceIds } },
    select: { id: true, name: true, group: { select: { mitmConfigPath: true, mitmConfig: true } } },
  });

  const found: Record<string, { name: string | null; reason?: string }> = {};
  const BATCH = 5;
  // Under the five minutes the dashboard's fetch allows. A box that never
  // answers costs the hub's exec timeout, so a large silent set would run past
  // it and lose every row — including the ones that did answer.
  const DEADLINE_MS = 3 * 60_000;
  const startedAt = Date.now();

  for (let i = 0; i < devices.length; i += BATCH) {
    if (Date.now() - startedAt > DEADLINE_MS) {
      for (const device of devices.slice(i)) {
        found[device.id] = { name: null, reason: "not read — the batch ran out of time" };
      }
      break;
    }
    await Promise.all(
      devices.slice(i, i + BATCH).map(async (device) => {
        const path = device.group?.mitmConfigPath;
        const template = device.group?.mitmConfig;
        if (!path || !template) {
          found[device.id] = { name: null, reason: `${device.name} is in no group with a config` };
          return;
        }
        const key = nameKeyIn(template);
        if (!key) {
          found[device.id] = {
            name: null,
            reason: "this group's config has no field that is exactly {{device.name}}",
          };
          return;
        }
        try {
          const result = await hub.execOnDevice(device.id, `cat ${JSON.stringify(path)}`);
          if (!result.ok) {
            found[device.id] = { name: null, reason: result.error ?? `could not read ${path}` };
            return;
          }
          const value = readAt(JSON.parse(result.output) as unknown, key);
          found[device.id] =
            typeof value === "string" && value.trim()
              ? { name: value.trim() }
              : {
                  name: null,
                  reason: `${key.join(".")} is not set in the config on ${device.name}`,
                };
        } catch (err) {
          found[device.id] = {
            name: null,
            // Never the output: a parse failure means we are holding the file.
            reason:
              err instanceof SyntaxError
                ? `the config on ${device.name} is not JSON`
                : toMessage(err),
          };
        }
      }),
    );
  }

  const read = Object.values(found).filter((entry) => entry.name).length;
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "device.namesImported",
      targetType: "Device",
      meta: { devices: devices.length, found: read, skipped: devices.length - read },
    },
  });

  return { ok: true, found, message: `Read ${read} of ${devices.length}.` };
}

/** Where the template puts the name, as a key path, or null if nowhere. */
function nameKeyIn(template: string): string[] | null {
  let parsed: unknown;
  try {
    // Tokens sit in two places: inside a string ("deviceName": "{{device.name}}"),
    // where the template is already valid JSON, and bare where a number or a
    // boolean goes ("workers": {{device.workers}}), where it is not. Only the
    // bare ones need quoting — quoting one that is already quoted doubles the
    // quotes and the parse fails, which used to read as "no such field".
    parsed = JSON.parse(
      template.replace(/"(?:[^"\\]|\\.)*"|\{\{[^{}]*\}\}/g, (match) =>
        match.startsWith('"') ? match : JSON.stringify(match),
      ),
    );
  } catch {
    return null;
  }
  let hit: string[] | null = null;
  const walk = (value: unknown, path: string[]) => {
    if (hit) return;
    // Only an exact match. A template like "tv-{{device.name}}" would need the
    // prefix stripped back off whatever the box reports, and guessing that
    // wrong writes a wrong name to the fleet.
    if (
      typeof value === "string" &&
      NAME_PLACEHOLDER.test(value) &&
      value.trim().match(/^\{\{[^{}]*\}\}$/)
    ) {
      hit = path;
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        walk(inner, [...path, key]);
      }
    }
  };
  walk(parsed, []);
  return hit;
}

function readAt(value: unknown, path: string[]): unknown {
  let cursor = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * Apply a rename to many boxes.
 *
 * The plan is worked out again here rather than trusting the names the browser
 * drew: the preview is a convenience, and this is the authority.
 */
export async function renameDevices(
  input:
    | ({ deviceIds: string[] } & RenameOptions)
    | { deviceIds: string[]; names: Record<string, { name: string | null; reason?: string }> },
): Promise<ActionState & { renamed?: number }> {
  const user = await requireOperator();
  if (input.deviceIds.length === 0) return { error: "No boxes picked." };

  const [devices, fleet] = await Promise.all([
    prisma.device.findMany({
      where: { kind: "BOX", id: { in: input.deviceIds } },
      select: RENAME_SELECT,
    }),
    prisma.device.findMany({ where: { kind: "BOX" }, select: { id: true, name: true } }),
  ]);
  if (devices.length !== input.deviceIds.length) {
    return { error: "A box in the selection is no longer there. Reopen the dialog." };
  }

  const byId = new Map(devices.map((device) => [device.id, device]));
  const targets = input.deviceIds
    .map((id) => byId.get(id))
    .filter((d): d is LoadedDevice => Boolean(d))
    .map(toTarget);

  const plan =
    "names" in input
      ? planFromNames(targets, fleet, input.names)
      : planRename(targets, fleet, input);
  if (plan.error) return { error: plan.error };

  const changes = plan.rows.filter((row) => row.status === "rename");
  if (changes.length === 0) return { error: "Nothing to change." };

  // One transaction: a naming scheme half-applied leaves the fleet in two
  // schemes and the operator working out which boxes are missing.
  await prisma.$transaction(
    changes.map((row) =>
      prisma.device.update({ where: { id: row.deviceId }, data: { name: row.to } }),
    ),
  );

  const serials = new Map(devices.map((device) => [device.id, device.serial]));
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "device.rename",
      targetType: "Device",
      // The old names, not just a count: this row is the only place they
      // survive, and "somebody renamed forty boxes with a bad pattern" has to
      // be answerable.
      meta: {
        ...("names" in input
          ? { source: "boxes" }
          : {
              pattern: input.pattern,
              order: input.order,
              startAt: input.startAt,
              step: input.step,
            }),
        devices: targets.length,
        renamed: changes.map((row) => ({
          serial: serials.get(row.deviceId) ?? null,
          from: row.from,
          to: row.to,
        })),
      },
    },
  });

  revalidateDeviceViews();
  return {
    ok: true,
    renamed: changes.length,
    message: `Renamed ${changes.length} box${changes.length === 1 ? "" : "es"}.`,
  };
}
