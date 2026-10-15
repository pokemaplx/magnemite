import { prisma } from "@magnemite/db";
import { bus } from "../bus.js";
import { log } from "../log.js";
import { isOnline } from "../registry.js";
import { execOnDevice } from "./deviceCommands.js";

/**
 * A box somebody is working on, and the fleet agreeing to leave it alone.
 *
 * Without this, the only way to touch a box by hand was to race the thing that
 * is watching it. You stop the scanner to look at something, the monitor pass
 * reads a dead scanner, and the box is restarted — or rebooted — underneath
 * you. The auto-rollout has the same problem from the other end: it queues an
 * install on the box you are holding.
 *
 * So: a window, during which everything the fleet does **on its own
 * initiative** skips the box, and a rollout aimed straight at it is refused
 * saying why rather than queued to land halfway through the repair.
 *
 * Three decisions worth keeping:
 *
 *  - **A timestamp, not a flag.** The failure mode of a boolean is a box that
 *    quietly stops being watched: somebody sets it, forgets, and months later
 *    there is one box no rule has ever fired on. This runs out by itself.
 *  - **Entering stops the scanner, leaving starts it again.** The group
 *    already says how, in the hooks a rollout uses for exactly this reason,
 *    and inventing a second answer here would be a second thing to keep in
 *    step. Entering without the second half would be worse than neither: a box
 *    whose scanner is stopped and nothing left to start it.
 *  - **The diagnostics stay.** Logs, live logs, Execute, screenshots and
 *    reboot are the tools somebody in maintenance is holding. Blocking those
 *    would be blocking the point.
 */

/**
 * The longest window somebody can park a box for in one go.
 *
 * A week, which is long enough for hardware waiting on a part and short enough
 * that it is not the boolean this exists instead of. Re-applying it is one
 * click, and that click is the review this number is really asking for.
 */
export const MAX_MAINTENANCE_MINUTES = 7 * 24 * 60;

/** Long enough for `am force-stop` to think, short enough that a dialog waits. */
const HOOK_TIMEOUT_SECONDS = 30;

/**
 * A `where` fragment for "boxes nothing automatic should touch right now".
 *
 * Spread into a device filter: `device: { approved: true, ...notInMaintenance() }`.
 * It contains an `OR`, so it must not be spread into an object that already has
 * one — nest it under `AND` there instead, or the second would replace the first
 * and the filter would silently stop filtering.
 */
export function notInMaintenance() {
  return {
    OR: [{ maintenanceUntil: null }, { maintenanceUntil: { lte: new Date() } }],
  };
}

/**
 * The same question asked of a row already in hand.
 *
 * An expired timestamp reads as *not* in maintenance here, before the sweep has
 * cleared it. That is deliberate: the window is what the field means, and a box
 * whose window closed a second ago is free whether or not a tick has run.
 */
export function inMaintenance(device: { maintenanceUntil: Date | null }): boolean {
  return device.maintenanceUntil !== null && device.maintenanceUntil.getTime() > Date.now();
}

/** What happened to the hook that was supposed to stop or start the scanner. */
export type HookOutcome = {
  /** The command, or null when the group has none for this half. */
  command: string | null;
  ran: boolean;
  /** Why it did not run, in words for a dialog. Null when it did, or had nothing to do. */
  skipped: string | null;
  /** What the box said when it failed. Null on success. */
  error: string | null;
};

export type MaintenanceOutcome = {
  deviceName: string;
  /** Null once released. */
  until: Date | null;
  hook: HookOutcome;
};

const NOTHING: HookOutcome = { command: null, ran: false, skipped: null, error: null };

/**
 * Park a box.
 *
 * The field is written **before** the hook runs, and the order is the point: the
 * hook stops the scanner, and a monitor pass landing between the two would read
 * a stopped scanner on a box it still believes is in service — which is the
 * exact restart this feature exists to prevent.
 *
 * A hook that cannot run never fails the call. Entering maintenance is the
 * operator's decision and it has already been recorded; what the scanner is
 * doing is a detail the outcome reports so the dialog can say "the box is
 * offline, so nothing was stopped" instead of pretending.
 */
export async function enterMaintenance(
  deviceId: string,
  minutes: number,
  requestedByEmail: string | null,
): Promise<MaintenanceOutcome> {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error("a maintenance window needs a positive number of minutes");
  }
  if (minutes > MAX_MAINTENANCE_MINUTES) {
    throw new Error(
      `a maintenance window cannot be longer than ${MAX_MAINTENANCE_MINUTES / 60} hours`,
    );
  }

  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: {
      id: true,
      name: true,
      kind: true,
      group: { select: { preInstallHook: true } },
    },
  });
  if (!device) throw new Error("device not found");

  const until = new Date(Date.now() + minutes * 60_000);
  await prisma.device.update({ where: { id: deviceId }, data: { maintenanceUntil: until } });
  bus.publish({ kind: "device", deviceId });

  log.info(
    { deviceId, device: device.name, until, by: requestedByEmail },
    "box parked for maintenance",
  );

  const hook = await runHook(
    device.id,
    device.kind === "BOX" ? device.group?.preInstallHook : null,
    "stop the scanner",
  );
  return { deviceName: device.name, until, hook };
}

/**
 * Put a box back in service, by hand or because its window ran out.
 *
 * The post-install hook here is the other half of the pre-install hook above.
 * It is best-effort for the same reason, and on an offline box it simply does
 * not happen — the box comes back with whatever its own boot does, and the
 * monitoring rules, which are watching again by then, are what notice if that
 * was not enough. That is a better answer than anything this function could
 * invent, because it is the same answer they give for every other dead scanner.
 */
export async function releaseMaintenance(
  deviceId: string,
  requestedByEmail: string | null,
): Promise<MaintenanceOutcome> {
  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: {
      id: true,
      name: true,
      kind: true,
      maintenanceUntil: true,
      group: { select: { postInstallHook: true } },
    },
  });
  if (!device) throw new Error("device not found");
  if (device.maintenanceUntil === null) {
    return { deviceName: device.name, until: null, hook: NOTHING };
  }

  // Conditional on the column still being set, and the count is what decides
  // whether the hook runs. Two things can ask for this release at once -- the
  // sweep fires them without awaiting and runs every five seconds, and a
  // person can press End while one is in flight -- and clearing it twice is
  // harmless where starting the scanner twice is a force-stop landing on an
  // app that had just come back.
  const { count } = await prisma.device.updateMany({
    where: { id: deviceId, maintenanceUntil: { not: null } },
    data: { maintenanceUntil: null },
  });
  if (count === 0) {
    return { deviceName: device.name, until: null, hook: NOTHING };
  }
  bus.publish({ kind: "device", deviceId });

  log.info(
    { deviceId, device: device.name, by: requestedByEmail ?? "expiry" },
    "box back in service",
  );

  const hook = await runHook(
    device.id,
    device.kind === "BOX" ? device.group?.postInstallHook : null,
    "start the scanner",
  );
  return { deviceName: device.name, until: null, hook };
}

/**
 * Close the windows that have run out.
 *
 * Rides the scheduler tick, and runs **before** the dispatch on purpose: a job
 * held for a box whose window just closed should go out after the hook that
 * starts its scanner, not before it.
 *
 * Clearing the column is what makes this idempotent — an expired row is swept
 * exactly once, because after the sweep there is nothing left to match. The
 * hook is not awaited: it is one `am start` per box and the tick has a fleet to
 * get through.
 */
export async function sweepExpiredMaintenance(): Promise<number> {
  const expired = await prisma.device.findMany({
    where: { maintenanceUntil: { not: null, lte: new Date() } },
    select: { id: true, name: true },
  });
  if (expired.length === 0) return 0;

  for (const device of expired) {
    void releaseMaintenance(device.id, null).catch((err) => {
      log.warn({ err, deviceId: device.id }, "could not take a box out of maintenance");
    });
  }
  log.info({ devices: expired.length }, "maintenance windows expired");
  return expired.length;
}

/**
 * Run one of a group's hooks, and report rather than throw.
 *
 * `what` is the half being attempted, so a refusal reads as a sentence: "the
 * box is offline, so nothing ran to stop the scanner".
 */
async function runHook(
  deviceId: string,
  command: string | null | undefined,
  what: string,
): Promise<HookOutcome> {
  const trimmed = command?.trim();
  if (!trimmed) {
    return {
      command: null,
      ran: false,
      // Not a failure: plenty of groups have no hooks, and a box whose group
      // says nothing about starting a scanner has nothing for this to do.
      skipped: `this box's group has no hook to ${what}`,
      error: null,
    };
  }
  if (!isOnline(deviceId)) {
    return {
      command: trimmed,
      ran: false,
      skipped: `the box is offline, so nothing ran to ${what}`,
      error: null,
    };
  }

  try {
    const outcome = await execOnDevice(deviceId, trimmed, HOOK_TIMEOUT_SECONDS);
    if (outcome.ok) return { command: trimmed, ran: true, skipped: null, error: null };
    return {
      command: trimmed,
      ran: false,
      skipped: null,
      // A non-zero exit usually says nothing in `error` and puts the reason on
      // stderr, which `execOnDevice` folds into the output.
      error: outcome.error ?? (outcome.output.trim() || "the hook exited non-zero"),
    };
  } catch (err) {
    return {
      command: trimmed,
      ran: false,
      skipped: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
