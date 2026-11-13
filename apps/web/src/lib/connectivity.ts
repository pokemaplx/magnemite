import "server-only";

import { getHubSettings, prisma, type DeviceConnectionCause } from "@magnemite/db";

/**
 * What the hub recorded about staying in touch with one box.
 *
 * Mirrors `rotom-trend.ts` on purpose: the two sit on sibling pages, and a
 * reader should not have to learn that one of them means something different
 * by "the last hour".
 *
 * The two bands together are the diagnosis, and neither says it alone.
 * Reachable-yes with reporting-no is an agent that wedged while its socket
 * stayed up — the fault that used to be announced as "unreachable". Both no is
 * a box that really went away.
 */
export type ConnectivityTrend = {
  /** Did the hub have contact with the box across this bucket? */
  reachable: (boolean | null)[];
  /** Did a heartbeat actually land in it? */
  reporting: (boolean | null)[];
};

export const EMPTY_CONNECTIVITY_TREND: ConnectivityTrend = { reachable: [], reporting: [] };

export async function loadConnectivityTrend(
  deviceId: string,
  points = 40,
): Promise<ConnectivityTrend> {
  const windowMs = 60 * 60 * 1000;
  const to = Date.now();
  const from = to - windowMs;
  const slot = windowMs / points;

  const [device, episodes, samples, settings] = await Promise.all([
    prisma.device.findUnique({ where: { id: deviceId }, select: { createdAt: true } }),
    prisma.deviceConnectionEvent.findMany({
      where: {
        deviceId,
        // Overlaps the window: started before it ends, and had not ended when
        // it began. An episode still open has no `endedAt` and overlaps by
        // definition.
        startedAt: { lte: new Date(to) },
        OR: [{ endedAt: null }, { endedAt: { gte: new Date(from) } }],
      },
      select: { startedAt: true, endedAt: true },
    }),
    prisma.deviceMetricSample.findMany({
      where: { deviceId, at: { gte: new Date(from) } },
      select: { at: true },
      orderBy: { at: "asc" },
    }),
    getHubSettings(),
  ]);
  if (!device) return EMPTY_CONNECTIVITY_TREND;

  // Before the box existed, or before anything was being kept, is "we were not
  // recording" — which must not be painted as "it was fine".
  const bornAt = device.createdAt.getTime();
  const recordingConnectivity = settings.connectionRetentionDays > 0;
  const recordingMetrics = settings.metricsRetentionDays > 0;

  const reachable: (boolean | null)[] = [];
  const reporting: (boolean | null)[] = [];

  for (let i = 0; i < points; i += 1) {
    const start = from + i * slot;
    const end = start + slot;
    const known = end > bornAt;

    // True by default, because the episode table is the complete record of
    // lost contact for as long as the hub was up — and the stretches where it
    // was not up are themselves episodes.
    const lost = episodes.some(
      (e) => e.startedAt.getTime() < end && (e.endedAt === null || e.endedAt.getTime() > start),
    );
    reachable.push(known && recordingConnectivity ? !lost : null);

    const beat = samples.some((s) => s.at.getTime() >= start && s.at.getTime() < end);
    reporting.push(known && recordingMetrics ? beat : null);
  }

  return { reachable, reporting };
}

export type Episode = {
  id: number;
  startedAt: Date;
  endedAt: Date | null;
  durationSeconds: number | null;
  cause: DeviceConnectionCause | null;
  closeCode: number | null;
  closeReason: string | null;
  hubRestarted: boolean;
  uptimeBefore: number | null;
  uptimeAfter: number | null;
  bootReason: string | null;
  sessionAfter: string | null;
  agentVersionBefore: string | null;
  agentVersionAfter: string | null;
  bundleId: string | null;
  bundleReady: boolean;
};

/** Episodes in a window, newest first, with the log bundle each one carries. */
export async function loadEpisodes(deviceId: string, sinceMs: number): Promise<Episode[]> {
  const rows = await prisma.deviceConnectionEvent.findMany({
    where: { deviceId, startedAt: { gte: new Date(Date.now() - sinceMs) } },
    orderBy: { startedAt: "desc" },
    take: 500,
    include: {
      // At most one is collected per episode, and only when the setting is on.
      logBundles: { select: { id: true, state: true }, take: 1, orderBy: { requestedAt: "desc" } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationSeconds: row.durationSeconds,
    cause: row.cause,
    closeCode: row.closeCode,
    closeReason: row.closeReason,
    hubRestarted: row.hubRestarted,
    uptimeBefore: row.uptimeBefore,
    uptimeAfter: row.uptimeAfter,
    bootReason: row.bootReason,
    sessionAfter: row.sessionAfter,
    agentVersionBefore: row.agentVersionBefore,
    agentVersionAfter: row.agentVersionAfter,
    bundleId: row.logBundles[0]?.id ?? null,
    bundleReady: row.logBundles[0]?.state === "READY",
  }));
}

/**
 * What each cause means, in the words an operator would use.
 *
 * Kept beside the loader rather than in the component because the drill-down
 * and the table both say it, and two copies would drift.
 */
export const CAUSE_LABELS: Record<DeviceConnectionCause, string> = {
  HUB_RESTART: "Magnemite restarted",
  REPLACED: "reconnected before the old socket timed out",
  DEVICE_DELETED: "dialled in with no record of it",
  TERMINATED_BY_HUB: "stopped answering the keepalive",
  LINK_LOST: "the connection dropped without a goodbye",
  AGENT_RESTART: "the agent restarted",
  REBOOT: "the box rebooted",
  HEARTBEAT_STALL: "connected, and stopped reporting",
};

export const CAUSE_DETAIL: Record<DeviceConnectionCause, string> = {
  HUB_RESTART:
    "The hub itself was down for part of this gap, so nothing here is evidence about the box.",
  REPLACED:
    "A newer connection from the same box took over. Usually a box that reconnected before its old socket had timed out.",
  DEVICE_DELETED: "The box presented a token for a device that no longer exists.",
  TERMINATED_BY_HUB:
    "Two keepalives went unanswered, so the hub hung up. The box was wedged, asleep, or off the network.",
  LINK_LOST:
    "The socket went without a close frame and the agent did not restart — power, network, or the agent's own read deadline.",
  AGENT_RESTART:
    "Same boot, a new agent process: a self-update, a crash, or the service script respawning it.",
  REBOOT: "The box itself restarted — its boot instant moved.",
  HEARTBEAT_STALL:
    "The socket never closed and the beats stopped. The box was reachable the whole time, so a restart or a reboot could have been sent to it.",
};

/** Danger reads as "the box went away"; warning as "it was there and wrong". */
export function causeVariant(
  cause: DeviceConnectionCause | null,
): "danger" | "warning" | "secondary" | "outline" {
  if (cause === null) return "outline";
  if (cause === "REBOOT" || cause === "LINK_LOST") return "danger";
  if (cause === "HEARTBEAT_STALL" || cause === "TERMINATED_BY_HUB") return "warning";
  if (cause === "HUB_RESTART") return "outline";
  return "secondary";
}
