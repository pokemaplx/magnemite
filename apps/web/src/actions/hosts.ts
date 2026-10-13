"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@magnemite/db";
import { requireOperator } from "@/lib/session";
import { hub, HubError } from "@/lib/hub";
import type { ActionState } from "@/actions/rollouts";

/**
 * Everything the Machines page does.
 *
 * Reads go straight to Prisma from the pages, as everywhere else. These are the
 * writes, and all of them have to reach a live socket — which is why each one
 * goes through the hub rather than writing rows here and hoping.
 */

function revalidateHost(id: string) {
  revalidatePath("/hosts");
  revalidatePath(`/hosts/${id}`);
  // A converge can change which boxes exist, so the fleet is stale too.
  revalidatePath("/");
}

/**
 * Set how many containers a machine runs.
 *
 * Zero is valid and is how a machine is drained, so it is deliberately not
 * refused. Capacity is advice rather than a limit: the form says what fits and
 * warns past it, and an operator who knows their own hardware better than the
 * coefficients do is allowed to say so.
 */
export async function scaleHost(
  hostId: string,
  count: number,
  workers: number | null,
  memLimitBytes?: number | null,
): Promise<ActionState & { reason?: string }> {
  const user = await requireOperator();

  if (!Number.isInteger(count) || count < 0) return { error: "Instances must be 0 or more." };
  if (count > 64) return { error: "64 containers on one machine is past anything sensible." };
  if (workers !== null && (!Number.isInteger(workers) || workers < 1 || workers > 50)) {
    // 50 is where the scanners stop being happy, and on some licences it is
    // also the contractual ceiling. It is the whole reason a machine needs
    // several containers rather than one big one.
    return { error: "Workers must be between 1 and 50." };
  }
  // Undefined is "do not touch", null is "go back to the fleet-wide number".
  // Only a real value is range-checked, and the floor is where Android stops
  // booting rather than where it gets slow.
  if (memLimitBytes !== undefined && memLimitBytes !== null) {
    if (!Number.isInteger(memLimitBytes) || memLimitBytes < 512 * 1024 * 1024) {
      return { error: "Memory per container must be at least 512 MB." };
    }
    if (memLimitBytes > 64 * 1024 * 1024 * 1024) {
      return { error: "64 GB for one container is past anything sensible." };
    }
  }

  try {
    const result = await hub.scaleHost(hostId, count, workers, memLimitBytes);
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        userEmail: user.email,
        action: "redroidHost.scale",
        targetType: "RedroidHost",
        targetId: hostId,
        meta: { count, workers, memLimitBytes, added: result.added, removed: result.removed },
      },
    });
    revalidateHost(hostId);
    // The reason is carried through rather than swallowed: "nothing happened"
    // has several causes an operator needs told apart — offline, not adopted,
    // or already exactly right.
    return { ok: true, reason: result.sent ? undefined : result.reason };
  } catch (err) {
    return { error: err instanceof HubError ? err.message : "Could not scale that machine." };
  }
}

/** Import the containers a machine already has, so a first converge is safe. */
export async function adoptHost(hostId: string): Promise<ActionState & { adopted?: number }> {
  const user = await requireOperator();
  try {
    const { adopted } = await hub.adoptHost(hostId);
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        userEmail: user.email,
        action: "redroidHost.adopt",
        targetType: "RedroidHost",
        targetId: hostId,
        meta: { adopted },
      },
    });
    revalidateHost(hostId);
    return { ok: true, adopted };
  } catch (err) {
    return { error: err instanceof HubError ? err.message : "Could not adopt that machine." };
  }
}

/** Re-send the compose file, even when its hash already matches. */
export async function convergeHost(hostId: string): Promise<ActionState & { reason?: string }> {
  const user = await requireOperator();
  try {
    const result = await hub.convergeHost(hostId, true);
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        userEmail: user.email,
        action: "redroidHost.converge",
        targetType: "RedroidHost",
        targetId: hostId,
        meta: { sent: result.sent },
      },
    });
    revalidateHost(hostId);
    return { ok: true, reason: result.sent ? undefined : result.reason };
  } catch (err) {
    return { error: err instanceof HubError ? err.message : "Could not converge that machine." };
  }
}

/**
 * The job states a device can be busy in.
 *
 * Shared by the two places here that destroy a container: a job mid-install on
 * a box that is about to stop existing has to be cancelled, or it sits in the
 * queue until the stall timeout re-queues it to a box that is no longer there.
 * The hub has its own `ACTIVE_STATES` and this is deliberately not imported
 * from it -- that is another app, and the web app reaches the hub over HTTP.
 */
const ACTIVE_JOB_STATES = [
  "QUEUED",
  "DISPATCHED",
  "DOWNLOADING",
  "EXTRACTING",
  "INSTALLING",
  "VERIFYING",
] as const;

/**
 * Cancels whatever those devices are in the middle of, before their containers
 * go. Best effort by design: a cancel that fails must not stop the removal,
 * because the container is going either way.
 */
async function cancelActiveJobs(deviceIds: string[]): Promise<void> {
  if (deviceIds.length === 0) return;
  const active = await prisma.job.findMany({
    where: { deviceId: { in: deviceIds }, state: { in: [...ACTIVE_JOB_STATES] } },
    select: { id: true },
  });
  for (const job of active) {
    await hub.cancelJob(job.id).catch(() => undefined);
  }
}

/**
 * Remove one container, or forget it entirely.
 *
 * The two are different operations and the difference is the whole point.
 * Remove destroys the container and keeps both the volume and the `Device` row,
 * so re-adding that index brings the same box back with its history, its name
 * and its group. Forget deletes the row, and the box's identity goes with it.
 *
 * Neither renumbers. Removing index 3 of ten leaves a gap the next scale-up
 * refills, because closing it would rewrite serials and a changed serial is a
 * new box with no history.
 */
export async function removeInstance(
  instanceId: string,
  forget: boolean,
): Promise<ActionState & { reason?: string }> {
  const user = await requireOperator();

  const instance = await prisma.redroidInstance.findUnique({
    where: { id: instanceId },
    select: { id: true, hostId: true, index: true, deviceId: true },
  });
  if (!instance) return { error: "That instance is no longer there." };

  // Cancelled first, so the rollout shows a cancellation rather than a mystery.
  await cancelActiveJobs(instance.deviceId ? [instance.deviceId] : []);

  try {
    if (forget) {
      // The Device row goes too. Its serial was minted for this instance and
      // nothing else will ever present it, so leaving the row behind would
      // leave a box in the fleet table that can never come back.
      await prisma.redroidInstance.delete({ where: { id: instanceId } });
      if (instance.deviceId) {
        await prisma.device.delete({ where: { id: instance.deviceId } }).catch(() => undefined);
      }
    } else {
      await prisma.redroidInstance.update({
        where: { id: instanceId },
        data: { present: false },
      });
    }

    await prisma.auditLog.create({
      data: {
        userId: user.id,
        userEmail: user.email,
        action: forget ? "redroidInstance.forget" : "redroidInstance.remove",
        targetType: "RedroidInstance",
        targetId: instanceId,
        meta: { index: instance.index, hostId: instance.hostId },
      },
    });

    const result = await hub.convergeHost(instance.hostId);
    revalidateHost(instance.hostId);
    return { ok: true, reason: result.sent ? undefined : result.reason };
  } catch (err) {
    return { error: err instanceof HubError ? err.message : "Could not remove that instance." };
  }
}

/**
 * What a machine's new containers are called when they enrol.
 *
 * Straight to the database and not through the hub, like the group beside it:
 * nothing is rendered into the compose file and no container is recreated. It
 * is read once, at the moment a box first enrols, and a machine that is
 * offline right now will still use it when its containers come up.
 *
 * Empty clears it and goes back to the name the box makes from what Android
 * reports. Changing it never renames a box that already enrolled -- those keep
 * the row they have, which is also what makes a rename by hand stick.
 */
export async function setHostNameTemplate(
  hostId: string,
  template: string | null,
): Promise<ActionState> {
  const user = await requireOperator();

  const trimmed = template?.trim() ?? "";
  if (trimmed.length > 64) return { error: "That template is longer than a device name can be." };

  try {
    await prisma.redroidHost.update({
      where: { deviceId: hostId },
      data: { nameTemplate: trimmed === "" ? null : trimmed },
    });
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        userEmail: user.email,
        action: "redroidHost.setNameTemplate",
        targetType: "RedroidHost",
        targetId: hostId,
        meta: { template: trimmed === "" ? null : trimmed },
      },
    });
    revalidateHost(hostId);
    return { ok: true };
  } catch {
    return { error: "Could not set the name template for that machine." };
  }
}

/** The site a machine's new containers enrol into. */
export async function setHostGroup(hostId: string, groupId: string | null): Promise<ActionState> {
  const user = await requireOperator();
  try {
    await prisma.redroidHost.update({
      where: { deviceId: hostId },
      data: { defaultGroupId: groupId },
    });
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        userEmail: user.email,
        action: "redroidHost.setGroup",
        targetType: "RedroidHost",
        targetId: hostId,
        meta: { groupId },
      },
    });
    revalidateHost(hostId);
    return { ok: true };
  } catch {
    return { error: "Could not set the group for that machine." };
  }
}

/**
 * Provision a machine, from the moment its provider handed over SSH access.
 *
 * The one action that is the whole point of the feature: a machine goes from an
 * address and a password to running containers without anything else being
 * typed. It returns as soon as the run starts, because the SSH half is minutes
 * — apt, Docker, kernel modules, possibly a reboot — and the row it creates is
 * what the page renders.
 *
 * The credential is passed straight through and kept nowhere. It is not in the
 * row, not in the log, and not in the audit entry below — which records the
 * machine, its address and who asked, because that is what an audit trail is
 * for and a password is not.
 *
 * The group is asked for here rather than left for the machine's page, because
 * the run ends by starting the containers and their boxes enrol as they come
 * up. There is no window in which to set it afterwards: by the time the page
 * exists, the first batch is already in `default` and already carrying that
 * group's MITM config.
 */
export async function bootstrapHost(input: {
  name: string;
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  desiredInstances: number;
  desiredWorkers: number | null;
  desiredGroupId: string | null;
  desiredNameTemplate: string | null;
}): Promise<ActionState & { id?: string }> {
  const user = await requireOperator();

  // Trimmed, and then *used* trimmed. Checking `input.host.trim()` while
  // sending `input.host` is what turned a pasted leading space into
  // `getaddrinfo ENOTFOUND  1.2.3.4` -- a twenty-minute provisioning that
  // failed on an address whose only visible defect was a double space.
  //
  // Not the password, the key or the passphrase: a password may begin or end
  // with a space on purpose, and a key belongs to its parser byte for byte.
  const name = input.name.trim();
  const host = input.host.trim();
  const username = input.username.trim();

  if (!name) return { error: "Give the machine a name." };
  if (!host) return { error: "Where should it connect?" };
  if (!username) return { error: "Which user should it log in as?" };
  if (!input.password && !input.privateKey) {
    return { error: "A password or a private key is needed to reach the machine." };
  }

  // The two pastes that look right and are not, each named with the field to
  // fix. Worth catching here because the alternative is a resolver error that
  // says nothing about which box on the form was wrong.
  if (host.includes("@")) {
    return { error: "Only the address goes here — the login user has its own field." };
  }
  if (/\s/.test(host)) {
    return { error: "That address has a space in it." };
  }
  // Exactly one colon, so a bare IPv6 address is not mistaken for host:port.
  const [address, maybePort, ...rest] = host.split(":");
  if (address && maybePort && rest.length === 0 && /^[0-9]+$/.test(maybePort)) {
    return { error: `Put the port in its own field: address ${address}, port ${maybePort}.` };
  }
  if (input.desiredInstances < 0 || input.desiredInstances > 64) {
    return { error: "Instances must be between 0 and 64." };
  }

  // Refused here rather than discovered at the end of a twenty-minute run: the
  // hub keys a machine on its name, and two machines sharing one would be one
  // machine as far as the fleet is concerned.
  const clash = await prisma.device.findFirst({
    where: { kind: "HOST", name },
    select: { id: true },
  });
  if (clash) return { error: `There is already a machine called ${name}.` };

  try {
    const { id } = await hub.bootstrapHost({ ...input, name, host, username });
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        userEmail: user.email,
        action: "redroidHost.bootstrap",
        targetType: "RedroidBootstrap",
        targetId: id,
        meta: {
          name,
          // The address, which identifies the machine. Never the credential.
          address: `${username}@${host}`,
          desiredInstances: input.desiredInstances,
          // Which site its boxes will come up in, which is a decision and not
          // a detail: it picks the MITM config they are handed.
          desiredGroupId: input.desiredGroupId,
          desiredNameTemplate: input.desiredNameTemplate,
        },
      },
    });
    revalidatePath("/hosts");
    return { ok: true, id };
  } catch (err) {
    return {
      error: err instanceof HubError ? err.message : "Could not start provisioning that machine.",
    };
  }
}

/**
 * How long a run may say RUNNING before nothing can still be working on it.
 *
 * The hub's own SSH timeout, which is what makes this a fact rather than a
 * guess: a live run gives up by itself after it, so a row older than this is
 * either finished or orphaned — and orphaned is what a hub restart mid-run
 * leaves behind, because the run lives in a closure that goes with the process.
 */
const RUN_ABANDONED_AFTER_MS = 20 * 60 * 1000;

/**
 * Takes a finished or abandoned provisioning off the page.
 *
 * The Machines page lists every run that is not DONE, and nothing prunes them,
 * so a failure stays on screen until somebody says otherwise. That is right —
 * a provisioning that failed at four in the morning should still be there at
 * nine — but it needs a way to say otherwise, and until now the only one was
 * SQL.
 *
 * A run that is genuinely still going is refused rather than hidden: the row is
 * the only thing watching it, and dismissing it would leave an SSH session
 * working on a machine nobody is being told about.
 */
export async function dismissBootstrap(id: string): Promise<ActionState> {
  const user = await requireOperator();

  const row = await prisma.redroidBootstrap.findUnique({
    where: { id },
    select: {
      name: true,
      serial: true,
      state: true,
      startedAt: true,
      // Kept for the audit entry: once the row is deleted these numbers exist
      // nowhere else, and they are what the operator asked for.
      desiredInstances: true,
      desiredWorkers: true,
    },
  });
  // Already gone. Idempotent on purpose: two clicks, or two tabs, must not
  // turn into an error the second time — but the page that offered the button
  // is showing a row that is not there, so it has to be refreshed or Dismiss
  // looks like a button that does nothing.
  if (!row) {
    revalidatePath("/hosts");
    return { ok: true };
  }

  if (row.state === "RUNNING" && Date.now() - row.startedAt.getTime() < RUN_ABANDONED_AFTER_MS) {
    // Deliberately not "wait and it will resolve itself". That is only true of
    // a run whose hub is alive: the timeout lives in the same process as the
    // run, so a hub that was killed mid-run takes the clock with it and
    // nothing will ever move this row. Both ways out are named instead.
    // Refreshed even on the refusal: the row may have moved on since the page
    // was rendered, and an operator told "it is still running" should be
    // looking at what it is still running.
    revalidatePath("/hosts");
    return {
      error:
        "That provisioning started less than twenty minutes ago and may still be running. " +
        "A live run gives up on its own after twenty; one whose hub has already been restarted " +
        "is marked failed the next time the hub starts, and can be dismissed then.",
    };
  }

  try {
    await prisma.redroidBootstrap.delete({ where: { id } });
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        userEmail: user.email,
        action: "redroidHost.dismissBootstrap",
        targetType: "RedroidBootstrap",
        targetId: id,
        // What was dismissed, since the row itself is gone: this entry is the
        // only remaining record that the attempt happened at all — including
        // what the machine was going to be brought up to, which the deleted
        // row was the only place holding.
        meta: {
          name: row.name,
          serial: row.serial,
          state: row.state,
          desiredInstances: row.desiredInstances,
          desiredWorkers: row.desiredWorkers,
        },
      },
    });
    revalidatePath("/hosts");
    return { ok: true };
  } catch {
    return { error: "Could not dismiss that provisioning." };
  }
}

/**
 * Take a machine out of the fleet, and leave it able to be added again.
 *
 * Three things have to happen in order, and the order is the whole design:
 *
 *  1. **Its containers and their volumes go.** Deleting only the rows would
 *     leave a VPS running Androids that nothing in Magnemite knows about —
 *     still scanning, still costing money, invisible.
 *
 *     The volumes go too, which is the one part that looks harsher than it is.
 *     A box's serial is derived from its machine's row id, and the volume is
 *     named after the compose service — so a machine added again gets new
 *     serials over the *same* volume names. The container would then boot with
 *     the previous box's `config.json`, enrol as that old device, and never
 *     match the instance row waiting for the new serial: a machine whose
 *     containers run and whose table says `not enrolled`, for ever. Left
 *     behind, those volumes can never be matched to anything again.
 *  2. **Its config goes.** `/etc/magnemite/host.json` holds the serial and the
 *     device token, and the agent keeps the config it finds. Left there, the
 *     machine would come back claiming a serial whose row no longer exists and
 *     a token nothing accepts — and the next `Add machine` would mint a second
 *     serial the script then discards, leaving a provisioning that waits for a
 *     machine that never dials in. Removing it is what makes re-adding work.
 *  3. **Then the rows, including each instance's own box.** `RedroidHost` and
 *     the instance rows cascade off the Device, but a box that enrolled from
 *     one of those containers has a `Device` row of its own that does not --
 *     and step 1 just destroyed the volume holding its identity. Its serial
 *     was minted `rd-<host>-NN` for a host row that is about to disappear, so
 *     nothing will ever present it again. Left behind it is one permanently
 *     offline box in the fleet table per instance, which is the same reason
 *     Forget deletes a row: deleting a machine forgets all of its instances at
 *     once, so it has to delete them the same way.
 *
 * A machine that cannot be reached is still deleted — an operator saying
 * "forget this" about a VPS that is already gone is the common case — but the
 * answer says so, because then steps 1 and 2 did not happen and the machine,
 * if it ever comes back, comes back as a stranger with containers running.
 */
export async function deleteHost(
  hostId: string,
  confirmName: string,
): Promise<ActionState & { warning?: string }> {
  const user = await requireOperator();

  const host = await prisma.device.findUnique({
    where: { id: hostId },
    select: {
      name: true,
      serial: true,
      kind: true,
      redroidHost: {
        select: { project: true, dir: true, instances: { select: { id: true, deviceId: true } } },
      },
    },
  });
  if (!host || host.kind !== "HOST") return { error: "That is not a machine." };
  // The second confirmation. Not a formality: this is the one action here that
  // takes containers down on a machine the dashboard then forgets, so it asks
  // for the name rather than a click somebody can give without reading.
  if (confirmName.trim() !== host.name) {
    return { error: `Type ${host.name} exactly to confirm.` };
  }

  let warning: string | undefined;
  const project = host.redroidHost?.project;
  const dir = host.redroidHost?.dir;
  if (project && dir) {
    // One command, because the machine stops being reachable partway through
    // it: the last thing it does is stop the agent that is running it, which
    // is why that part is backgrounded — the exec has to return first.
    //
    // `--volumes`, for the reason in the comment above: a volume this machine
    // leaves behind can never be matched to a box again, and the next machine
    // added here would mount it under a serial that is not the one inside it.
    const teardown = [
      `docker compose -p ${shellQuote(project)} --project-directory ${shellQuote(dir)} down --volumes --remove-orphans`,
      "rm -f /etc/magnemite/host.json",
      "systemctl disable magnemite-host >/dev/null 2>&1 || true",
      "(sleep 3; systemctl stop magnemite-host) >/dev/null 2>&1 &",
    ].join("; ");

    try {
      const result = await hub.execOnDevice(hostId, teardown, 300);
      if (!result.ok) {
        warning = `The machine answered but the teardown failed: ${result.error ?? result.output.slice(0, 300)}`;
      }
    } catch (err) {
      warning =
        err instanceof HubError && /offline/i.test(err.message)
          ? "The machine was offline, so its containers are still running and its agent still has its config. Stop them there by hand, or it will keep running boxes nothing is watching."
          : `Could not reach the machine: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const boxIds = (host.redroidHost?.instances ?? [])
    .map((instance) => instance.deviceId)
    .filter((id): id is string => id !== null);

  // Over HTTP to the hub, so before the transaction rather than inside it.
  await cancelActiveJobs(boxIds);

  try {
    // One transaction, because a half-deleted machine is worse than either
    // outcome: boxes gone with the machine still listed, or the reverse.
    //
    // The boxes go first only because it reads in the order it happens --
    // RedroidInstance.deviceId is SetNull, so either order works, and the
    // host's own delete is what cascades RedroidHost and the instance rows.
    await prisma.$transaction([
      prisma.device.deleteMany({ where: { id: { in: boxIds } } }),
      prisma.device.delete({ where: { id: hostId } }),
    ]);
  } catch {
    return { error: "Could not delete that machine." };
  }

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "redroidHost.delete",
      targetType: "Device",
      targetId: hostId,
      meta: {
        name: host.name,
        serial: host.serial,
        instances: host.redroidHost?.instances.length ?? 0,
        boxes: boxIds.length,
        drained: warning === undefined,
      },
    },
  });

  revalidatePath("/hosts");
  revalidatePath("/");
  return { ok: true, warning };
}

/** Single-quoted for the machine's shell, which is where these land. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\''`)}'`;
}

/**
 * Run the provisioning script again on a machine that is already up.
 *
 * The one repair that cannot be done any other way through the dashboard. It
 * reinstalls the kernel module for the kernel that is *now* running — which an
 * `apt upgrade` silently invalidates, taking every container down after the
 * reboot with nothing to explain it — and it rebuilds the Redroid image, which
 * is how a fixed image reaches a machine that already exists.
 *
 * Returns as soon as the request is sent. The run is minutes of apt and an
 * image build, and what it did lands on the machine's row when it reports.
 */
export async function rerunBootstrap(hostId: string): Promise<ActionState & { reason?: string }> {
  const user = await requireOperator();
  try {
    const result = await hub.rerunBootstrap(hostId);
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        userEmail: user.email,
        action: "redroidHost.bootstrap.rerun",
        targetType: "Device",
        targetId: hostId,
        meta: { sent: result.sent, reason: result.reason ?? null },
      },
    });
    revalidateHost(hostId);
    // "Done" would be a lie: what finished is the asking. The run is apt, a
    // kernel module and possibly an image build, and the steps land on this
    // page when the machine reports them.
    return result.sent
      ? { ok: true, reason: "Running now. It takes a few minutes; the steps appear here after." }
      : { ok: true, reason: result.reason };
  } catch (err) {
    return {
      error: err instanceof HubError ? err.message : "Could not ask that machine to re-run it.",
    };
  }
}
