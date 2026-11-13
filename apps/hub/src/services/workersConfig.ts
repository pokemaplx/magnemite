import { CAPABILITY_PUSH_CONFIG, hasCapability } from "@magnemite/protocol";
import { getRedroidSettings, prisma, resolveWorkers } from "@magnemite/db";
import { log } from "../log.js";
import { getConnection } from "../registry.js";
import { agentUpdateInFlight } from "./agentRelease.js";
import { pushConfig } from "./configPush.js";
import { deviceForConfigSelect, renderConfig, usesPlaceholder } from "./deviceConfig.js";
import { inMaintenance } from "./maintenance.js";

/**
 * Keeps every container's MITM config saying the workers it is configured for.
 *
 * The number is resolved -- the instance's own, else its machine's, else
 * Settings -- and any of the three can change, so nothing here listens for the
 * change itself. It compares what each box resolves to now against what its
 * config was last written with (`RedroidInstance.configWorkers`), and rewrites
 * the ones that differ, the same stop, write and start **Rewrite config** does.
 * A box that was offline or busy when the number moved is simply still behind
 * the next time it is looked at, which is the whole of "it gets it later".
 *
 * Most of this is refusals, because each rewrite restarts a scanner:
 *
 *  - **Null is left alone.** It means nothing Magnemite wrote is on the box,
 *    and the install that brings its MITM writes the first config itself.
 *  - **A config that does not say workers is not rewritten** -- it is the same
 *    file either way -- and is marked in step instead, so it is not asked
 *    about again on every tick.
 *  - **Only a box with its MITM installed**, on an agent that knows
 *    `push_config`, approved and not parked in maintenance. Unknown is not
 *    installed: a box whose inventory has not arrived is asked again later.
 *  - **A few at a time** -- Tuning → Concurrent config rewrites. A change in
 *    Settings moves every container that follows it, and a fleet whose
 *    scanners all restart in the same second is a fleet that stops scanning
 *    for that second.
 *  - **A failed rewrite waits before the next try.** Retried every tick, a box
 *    whose hook fails would have its scanner stopped and started forever.
 *
 * The bookkeeping is in memory and a hub restart forgets it, which costs at
 * most one early retry.
 */

/** How long a box that could not be asked right now waits to be asked again. */
const RECHECK_MS = 60_000;
/** And one whose rewrite was tried and failed. */
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;

const inFlight = new Set<string>();
const notBefore = new Map<string, number>();

/**
 * Called once a scheduler tick. Starts rewrites and returns; it does not wait
 * for them.
 *
 * `atOnce` is **Tuning → Concurrent config rewrites**, passed in by the tick
 * that has already read the settings. Lowering it below what is in flight
 * starts nothing new until enough have finished; nothing is cut short.
 */
export async function syncWorkersConfigs(atOnce: number): Promise<void> {
  if (inFlight.size >= atOnce) return;

  const rows = await prisma.redroidInstance.findMany({
    where: { present: true, deviceId: { not: null }, configWorkers: { not: null } },
    select: {
      deviceId: true,
      workers: true,
      configWorkers: true,
      host: { select: { workers: true } },
    },
  });
  if (rows.length === 0) return;
  const defaults = await getRedroidSettings();

  for (const row of rows) {
    if (inFlight.size >= atOnce) return;
    const deviceId = row.deviceId!;
    const wanted = resolveWorkers(row.workers, row.host.workers, defaults);
    if (wanted === row.configWorkers) continue;
    if (inFlight.has(deviceId) || (notBefore.get(deviceId) ?? 0) > Date.now()) continue;

    // Offline: still behind when it comes back, and this pass will see it.
    const conn = getConnection(deviceId);
    if (!conn || conn.readyAt === null) continue;
    // Busy now, free in a moment; not worth a cooldown.
    if (conn.currentJobId !== null || conn.pushingConfig || agentUpdateInFlight(conn)) continue;

    const device = await prisma.device.findUnique({
      where: { id: deviceId },
      select: {
        ...deviceForConfigSelect,
        approved: true,
        maintenanceUntil: true,
        capabilities: true,
      },
    });
    if (!device) continue;

    // Rendered here, before anything reaches the box, so a config that cannot
    // be written is told apart from a box that cannot be asked.
    const template = device.group?.mitmConfig;
    const rendered = renderConfig(device, defaults);
    if (!rendered || !template || !usesPlaceholder(template, "device.workers")) {
      // Nothing to write, or nothing in it that says workers: the same file
      // either way, so nothing is behind. Recorded only if the row has not
      // moved meanwhile, so a write that landed in between is kept.
      await markInStep(deviceId, row.configWorkers, wanted);
      continue;
    }
    if (!rendered.ok) {
      // Another placeholder empty on this box, most likely. Said once per
      // wait rather than once per tick, and the row stays behind, which is
      // what the dashboard shows.
      notBefore.set(deviceId, Date.now() + RETRY_AFTER_FAILURE_MS);
      log.warn(
        { deviceId, reason: rendered.reason },
        "a config whose workers changed cannot be rendered; trying again later",
      );
      continue;
    }

    if (
      !device.approved ||
      inMaintenance(device) ||
      !hasCapability(device.capabilities, CAPABILITY_PUSH_CONFIG) ||
      !(await mitmInstalled(deviceId, device.group?.mitmPackageName ?? null))
    ) {
      notBefore.set(deviceId, Date.now() + RECHECK_MS);
      continue;
    }

    inFlight.add(deviceId);
    void rewrite(deviceId, row.configWorkers, wanted);
  }
}

/**
 * Whether the scanner the config is for is on the box.
 *
 * A group with no package named cannot be asked, and is let through: its hooks
 * are its own, and the rewrite is the one **Rewrite config** would do.
 */
async function mitmInstalled(deviceId: string, packageName: string | null): Promise<boolean> {
  if (!packageName) return true;
  const row = await prisma.devicePackage.findUnique({
    where: { deviceId_packageName: { deviceId, packageName } },
    select: { installed: true },
  });
  return row?.installed === true;
}

async function markInStep(deviceId: string, was: number | null, now: number): Promise<void> {
  await prisma.redroidInstance.updateMany({
    where: { deviceId, configWorkers: was },
    data: { configWorkers: now },
  });
}

async function rewrite(deviceId: string, from: number | null, to: number): Promise<void> {
  try {
    // Null is the group's own template, rendered now -- so the number written
    // is whatever this box resolves to at the moment of the write, and
    // `pushConfig` records that one rather than `to`.
    const outcome = await pushConfig(deviceId, null);
    if (outcome.ok) {
      notBefore.delete(deviceId);
      // The file is in place either way. A hook that failed may have left the
      // scanner stopped, which is worth more than an info line.
      if (outcome.hookError) {
        log.warn(
          { deviceId, from, to, hookError: outcome.hookError },
          "config rewritten for its workers, but a hook failed",
        );
      } else {
        log.info({ deviceId, from, to }, "config rewritten: its workers changed");
      }
    } else {
      notBefore.set(deviceId, Date.now() + RETRY_AFTER_FAILURE_MS);
      log.warn(
        { deviceId, from, to, error: outcome.error },
        "could not rewrite a config whose workers changed; trying again later",
      );
    }
  } catch (err) {
    // A precondition that moved between the check above and the push: the box
    // went offline, or an install got to it first. Asked again soon.
    notBefore.set(deviceId, Date.now() + RECHECK_MS);
    log.debug(
      { deviceId, err: err instanceof Error ? err.message : String(err) },
      "workers config rewrite deferred",
    );
  } finally {
    inFlight.delete(deviceId);
  }
}
