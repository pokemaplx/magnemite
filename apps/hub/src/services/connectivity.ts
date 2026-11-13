import { prisma, type DeviceConnectionCause } from "@magnemite/db";
import { classify } from "./connectivityCause.js";
import { getHubSettings, getMonitorSettings } from "./hubSettings.js";
import { execOnDevice } from "./deviceCommands.js";
import { requestBundle } from "./deviceLogs.js";
import { getConnection, isOnline } from "../registry.js";
import { bus } from "../bus.js";
import { log } from "../log.js";

/**
 * The record of every stretch where the hub lost contact with a box.
 *
 * Nothing wrote one of these down before. A disconnection put its close code
 * on stdout and that was the whole of it, so "why did this box go unreachable
 * at 21:54" had no answer anywhere — and the two tools that could have
 * answered it, live logs and the log bundle, both need the box online, which
 * is exactly what it was not.
 *
 * An episode is an interval. It opens the moment contact is lost, closes on
 * the beat or hello that restores it, and is classified once, at the close,
 * when both ends of it are known.
 */

/**
 * deviceId → the id of the episode still open for it.
 *
 * Hub-local live state, in the same class as the socket registry rather than
 * a settings cache: it is a view of what is happening now, it is rebuilt from
 * the database at boot, and the database stays the record.
 */
const open = new Map<string, number>();

/**
 * Per-device serialisation.
 *
 * Open and close both read-then-write, and a box that reconnects the instant
 * it drops can have both in flight at once. Chaining per device costs nothing
 * — the map is empty on a healthy fleet — and removes the window in which one
 * box ends up with two open episodes.
 */
const chain = new Map<string, Promise<unknown>>();

function serialise<T>(deviceId: string, work: () => Promise<T>): Promise<T> {
  const next = (chain.get(deviceId) ?? Promise.resolve()).then(work, work);
  // Keep the chain from growing forever, and never let one failure poison the
  // next call for that box.
  chain.set(
    deviceId,
    next.catch(() => undefined),
  );
  void next
    .catch(() => undefined)
    .then(() => {
      if (chain.get(deviceId) === undefined) chain.delete(deviceId);
    });
  return next;
}

/** When this hub process started, for telling its own outages from a box's. */
const hubStartedAt = Date.now() - Math.round(process.uptime() * 1000);

export type OpenOpts = {
  /** Absent for a stall, which is the case where the socket never closed. */
  closeCode?: number | null;
  closeReason?: string | null;
  /** The hub hung up because the box stopped answering the keepalive. */
  terminatedByHub?: boolean;
};

/**
 * Rebuilds the open-episode map at boot.
 *
 * A hub restart leaves rows with no `endedAt` behind. They are still the truth
 * — those boxes really were out of contact — so they are adopted rather than
 * closed, and the box's next beat ends them.
 */
export async function loadOpenEpisodes(): Promise<number> {
  const rows = await prisma.deviceConnectionEvent.findMany({
    where: { endedAt: null },
    select: { id: true, deviceId: true },
  });
  open.clear();
  for (const row of rows) open.set(row.deviceId, row.id);
  if (rows.length > 0) log.info({ count: rows.length }, "adopted open connectivity episodes");
  return rows.length;
}

/**
 * Contact with a box was lost. Opens an episode, or enriches the open one.
 *
 * Idempotent on purpose. A stall that degenerates into a disconnection is one
 * period of lost contact that got worse, not two — so the open row takes the
 * close code it was missing and gets classified on that at the end.
 */
export async function openEpisode(deviceId: string, opts: OpenOpts = {}): Promise<void> {
  await serialise(deviceId, async () => {
    const existing = open.get(deviceId);
    if (existing !== undefined) {
      // Only ever fills blanks. The first thing that noticed is the one with
      // the honest `startedAt`, and a close code arriving later does not make
      // the gap have begun later.
      if (opts.closeCode !== undefined && opts.closeCode !== null) {
        await prisma.deviceConnectionEvent
          .updateMany({
            where: { id: existing, closeCode: null },
            data: {
              closeCode: opts.closeCode,
              closeReason: opts.closeReason ?? null,
            },
          })
          .catch(() => undefined);
      }
      return;
    }

    const device = await prisma.device.findUnique({
      where: { id: deviceId },
      select: {
        lastSeenAt: true,
        uptimeSeconds: true,
        bootedAt: true,
        agentStartedAt: true,
        agentVersion: true,
      },
    });
    if (!device) return;

    const row = await prisma.deviceConnectionEvent
      .create({
        data: {
          deviceId,
          // The last moment the box was known to be there, not the moment we
          // noticed — which is up to a sweep interval later.
          startedAt: device.lastSeenAt ?? new Date(),
          closeCode: opts.closeCode ?? null,
          closeReason: opts.closeReason ?? null,
          // Snapshotted here rather than read back at the close, so no
          // ordering against markOnline can lose it: by the time the box is
          // back, the row already says what it is now.
          uptimeBefore: device.uptimeSeconds,
          bootedAtBefore: device.bootedAt,
          agentStartedBefore: device.agentStartedAt,
          agentVersionBefore: device.agentVersion,
        },
        select: { id: true },
      })
      .catch((err) => {
        log.warn({ err, deviceId }, "could not open a connectivity episode");
        return null;
      });
    if (!row) return;

    open.set(deviceId, row.id);
    if (opts.terminatedByHub) terminated.add(deviceId);
  });
}

/**
 * Boxes the hub hung up on for not answering the keepalive.
 *
 * Kept beside the episode rather than on it because the flag is known at the
 * terminate and the row may not exist yet. Consumed at the close.
 */
const terminated = new Set<string>();

export function markTerminatedByHub(deviceId: string): void {
  terminated.add(deviceId);
}

/**
 * The box is back. Closes its episode and works out what the gap was.
 *
 * Called after the row has been updated with the new reading, so "after" is
 * simply what the device says now.
 */
export async function closeEpisode(deviceId: string): Promise<void> {
  if (!open.has(deviceId)) return;
  await serialise(deviceId, async () => {
    const id = open.get(deviceId);
    if (id === undefined) return;
    open.delete(deviceId);
    const wasTerminated = terminated.delete(deviceId);

    const [episode, device, settings] = await Promise.all([
      prisma.deviceConnectionEvent.findUnique({ where: { id } }),
      prisma.device.findUnique({
        where: { id: deviceId },
        select: {
          name: true,
          uptimeSeconds: true,
          bootedAt: true,
          agentStartedAt: true,
          agentVersion: true,
        },
      }),
      getHubSettings(),
    ]);
    if (!episode || !device) return;

    const endedAt = new Date();
    const durationSeconds = Math.max(
      0,
      Math.round((endedAt.getTime() - episode.startedAt.getTime()) / 1000),
    );
    const hubRestarted = hubStartedAt > episode.startedAt.getTime();

    // A gap the hub itself caused, too short to have taken the box offline,
    // flipped no status and raised no alert — it explains nothing and belongs
    // to nobody. Under `tsx watch` every file save is one of these per box,
    // and a wall of them would bury the episodes that matter. Dropped rather
    // than closed: one statement either way.
    if (hubRestarted && durationSeconds < settings.deviceOfflineTimeoutSeconds) {
      await prisma.deviceConnectionEvent.delete({ where: { id } }).catch(() => undefined);
      return;
    }

    const cause = classify({
      hubRestarted,
      closeCode: episode.closeCode,
      wasTerminated,
      durationSeconds,
      heartbeatSeconds: settings.heartbeatSeconds,
      uptimeBefore: episode.uptimeBefore,
      uptimeAfter: device.uptimeSeconds,
      bootedAtBefore: episode.bootedAtBefore,
      bootedAtAfter: device.bootedAt,
      agentStartedBefore: episode.agentStartedBefore,
      agentStartedAfter: device.agentStartedAt,
    });

    await prisma.deviceConnectionEvent
      .update({
        where: { id },
        data: {
          endedAt,
          durationSeconds,
          cause,
          hubRestarted,
          uptimeAfter: device.uptimeSeconds,
          bootedAtAfter: device.bootedAt,
          agentStartedAfter: device.agentStartedAt,
          agentVersionAfter: device.agentVersion,
          // From the socket rather than the row: it names the connection that
          // ended the gap, which is the stretch of agent.log worth reading.
          sessionAfter: getConnection(deviceId)?.sessionId ?? null,
        },
      })
      .catch((err) => log.warn({ err, deviceId }, "could not close a connectivity episode"));

    log.info(
      { deviceId, device: device.name, cause, durationSeconds, closeCode: episode.closeCode },
      "box back in contact",
    );
    bus.publish({ kind: "device", deviceId });

    // Both of these talk to the box, and neither may hold up the recovery:
    // requestBundle blocks for up to two minutes by design.
    void captureBootReason(deviceId, id, cause).catch(() => undefined);
    void maybeCaptureLogs(deviceId, id, cause, durationSeconds).catch((err) =>
      log.warn({ err, deviceId }, "automatic log capture failed"),
    );
  });
}

/**
 * Why the box rebooted, straight from Android, and only when it did.
 *
 * `getprop` reads init's property service rather than system_server, so it
 * still answers while the framework is restarting. A container has neither
 * property and comes back empty, which is the honest answer rather than a
 * missing one — nothing rebooted a container's bootloader, because it has
 * none.
 *
 * One exec per real reboot, which is rate-limited by how often boxes actually
 * reboot. This is also the direct test of "something on the box is rebooting
 * it": `reboot,userrequested` and `kernel_panic` and an empty answer are three
 * different stories, and they end up in the row.
 */
async function captureBootReason(
  deviceId: string,
  episodeId: number,
  cause: DeviceConnectionCause,
): Promise<void> {
  if (cause !== "REBOOT" || !isOnline(deviceId)) return;

  const out = await execOnDevice(
    deviceId,
    "getprop sys.boot.reason; getprop ro.boot.bootreason",
    20,
  ).catch(() => null);
  if (!out) return;

  const reason =
    out.output
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && line !== "unknown") ?? null;
  if (!reason) return;

  await prisma.deviceConnectionEvent
    .update({ where: { id: episodeId }, data: { bootReason: reason } })
    .catch(() => undefined);
}

/**
 * Grab the window that explains the outage, while the box is back to give it.
 *
 * The bundle carries the box's own agent.log, which survived the gap on its
 * disk — so this is the only way the dashboard can ever answer "what happened
 * at 21:54" after the fact.
 *
 * Every gate below is load-bearing; see the setting's own comment for why the
 * feature ships off.
 */
async function maybeCaptureLogs(
  deviceId: string,
  episodeId: number,
  cause: DeviceConnectionCause,
  durationSeconds: number,
): Promise<void> {
  // None of these are facts about the box, so none is worth a zip.
  if (cause === "HUB_RESTART" || cause === "DEVICE_DELETED" || cause === "REPLACED") return;
  if (!isOnline(deviceId)) return;

  const [monitor, hub] = await Promise.all([getMonitorSettings(), getHubSettings()]);
  if (!monitor.autoCollectLogsOnRecovery) return;
  // Only an episode long enough to have flipped the status and fired a rule is
  // a mystery worth a zip. Anything shorter nobody was ever told about.
  if (durationSeconds < hub.deviceOfflineTimeoutSeconds) return;
  // The same grace the monitor uses, for the same reason: under `tsx watch`
  // every file save drops the whole fleet, and a deploy does it in production.
  // Without this, both turn into a fleet-wide collection storm.
  if (Date.now() - hubStartedAt < monitor.startupGraceSeconds * 1000) return;

  // Both ceilings are counted in the database rather than in memory, for the
  // reason the alert dedupe is: the window has to outlive a hub restart,
  // because a restart is precisely when a whole fleet flaps at once.
  const since = new Date(Date.now() - monitor.autoCollectMinIntervalMinutes * 60_000);
  const mine = await prisma.deviceLogBundle.count({
    where: { deviceId, reason: "AUTO_RECOVERY", requestedAt: { gte: since } },
  });
  if (mine > 0) return;

  const hourAgo = new Date(Date.now() - 60 * 60_000);
  const fleet = await prisma.deviceLogBundle.count({
    where: { reason: "AUTO_RECOVERY", requestedAt: { gte: hourAgo } },
  });
  if (fleet >= monitor.autoCollectMaxPerHour) {
    log.warn({ fleet }, "automatic log capture is at its hourly ceiling; skipping");
    return;
  }

  log.info({ deviceId, cause, durationSeconds }, "collecting logs for a connectivity episode");
  await requestBundle(deviceId, null, { reason: "AUTO_RECOVERY", connectionEventId: episodeId });
}
