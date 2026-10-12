import type { deviceMetricsSchema } from "@magnemite/protocol";
import type { z } from "zod";
import { prisma } from "@magnemite/db";
import { getHubSettings } from "./hubSettings.js";
import { log } from "../log.js";

type DeviceMetrics = z.infer<typeof deviceMetricsSchema>;

/**
 * Health history behind the charts on /devices/[id]/metrics.
 *
 * The `Device` row carries only the latest reading, which answers "is this box
 * hot right now" but never "was it hot all night" — and the second question is
 * the one that explains a box that quietly stopped scanning. This module keeps
 * the second answer.
 *
 * Two knobs, both in Settings rather than env, because how much history is
 * worth its disk is a per-fleet call: `metricsSampleSeconds` (how often a beat
 * is kept) and `metricsRetentionDays` (how long it lives, 0 to record nothing).
 *
 * The sampling here is the heartbeat's alone. The Rotom sync keeps its own
 * readings, on the same two knobs, in `rotom.ts` — it has a different source
 * and a different cadence, and the one thing it does not have is a separate
 * prune: the sweep at the bottom of this file clears both tables, so a fleet
 * that sets a retention gets it applied to everything it asked for.
 */

/**
 * When each device was last sampled. Deliberately in memory: it is a rate
 * limiter, not a fact about the fleet, and the worst a hub restart can do is
 * store one extra sample per box.
 */
const lastSampleAt = new Map<string, number>();

/** How often the prune runs, independent of how often the scheduler ticks. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

/**
 * Deleting a week of a fleet's samples in one statement locks the table for
 * long enough to be felt by every heartbeat trying to insert into it. Chunked,
 * the prune is a series of short statements instead — slower overall, invisible
 * to everything else.
 */
const PRUNE_BATCH = 5_000;

function toBigInt(value: number | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  return BigInt(Math.trunc(value));
}

/**
 * Stores one point on a box's timeline, at most one per `metricsSampleSeconds`
 * slot of the clock.
 *
 * Called on every heartbeat — every 20 seconds, per box — so the early return
 * is the common path and does no I/O beyond the cached settings read.
 */
export async function recordSample(deviceId: string, metrics: DeviceMetrics): Promise<void> {
  const settings = await getHubSettings();
  if (settings.metricsRetentionDays <= 0) return;

  const now = Date.now();
  const previous = lastSampleAt.get(deviceId);
  const intervalMs = Math.max(settings.metricsSampleSeconds, 1) * 1000;

  // A floor of one heartbeat: asking for less than the beat interval cannot
  // produce more points, so the gate comes off entirely and every beat is
  // stored. Keeping it on would cost samples rather than save them — see why
  // below, and note that at this interval the two grids drift past each other
  // by a few milliseconds a beat, which is enough to lose a slot outright.
  if (settings.metricsSampleSeconds > settings.heartbeatSeconds) {
    // Anchored to the clock, not to the previous sample. Measuring "has it
    // been a minute since the last one I kept" sounds equivalent and is not:
    // the reference is an *arrival* time, so the wait restarts from wherever
    // the network happened to put it. Whenever the sample interval is a
    // multiple of the beat — 60 and 20, the defaults — that puts the
    // comparison exactly on the boundary, and the beat that should pass
    // arrives a few milliseconds early about half the time. Each rejection
    // pushes the sample a whole beat later and moves the reference with it, so
    // the error never washes out: the fleet settles at one sample per 80s
    // against a chart drawing 60s buckets, and the empty buckets read as
    // outages. Against the clock there is nothing to accumulate.
    if (
      previous !== undefined &&
      Math.floor(now / intervalMs) === Math.floor(previous / intervalMs)
    )
      return;
  }
  // Claimed before the await, so two heartbeats arriving together cannot both
  // decide they are the one to store. A timestamp rather than the slot index,
  // because the prune reads this map as "when was this box last seen".
  lastSampleAt.set(deviceId, now);

  const at = new Date(now);

  try {
    await prisma.deviceMetricSample.create({
      data: {
        deviceId,
        at,
        loadAvg1: metrics.loadAvg1 ?? null,
        loadAvg5: metrics.loadAvg5 ?? null,
        loadAvg15: metrics.loadAvg15 ?? null,
        cpuCount: metrics.cpuCount ?? null,
        memTotalBytes: toBigInt(metrics.memTotalBytes),
        memAvailableBytes: toBigInt(metrics.memAvailableBytes),
        freeBytes: toBigInt(metrics.freeBytes),
        totalBytes: toBigInt(metrics.totalBytes),
        cpuTempC: metrics.cpuTempC ?? null,
        batteryTempC: metrics.batteryTempC ?? null,
        // Null here rather than undefined, unlike the Device row: a sample is
        // one moment and a reading the box did not send at that moment is a
        // gap, which is what the chart has to draw.
        cpuPercent: metrics.cpuPercent ?? null,
        swapTotalBytes: toBigInt(metrics.swapTotalBytes),
        swapFreeBytes: toBigInt(metrics.swapFreeBytes),
      },
    });

    // An app that is not running sends nothing, and that absence is the point:
    // a gap in the chart is how "the scanner died at 3am" looks. Never write a
    // zero row to fill it.
    const processes = metrics.processes.filter((p) => p.packageName);
    if (processes.length > 0) {
      await prisma.devicePackageMetricSample.createMany({
        data: processes.map((process) => ({
          deviceId,
          packageName: process.packageName,
          at,
          cpuPercent: process.cpuPercent ?? null,
          rssBytes: toBigInt(process.rssBytes),
          processCount: process.processCount ?? null,
        })),
      });
    }
  } catch (err) {
    // History is nice to have; a box's heartbeat is not. A failed insert must
    // never cost the device its liveness, so this is swallowed rather than
    // thrown back at the socket handler.
    lastSampleAt.delete(deviceId);
    log.warn({ err, deviceId }, "failed to store metric sample");
  }
}

/**
 * Drops samples past the retention window.
 *
 * Runs off the scheduler tick, which fires every few seconds, so it keeps its
 * own hourly clock: an hour of extra rows is nothing next to a delete running
 * every five seconds against the biggest table in the schema.
 */
export async function pruneMetrics(force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - lastPruneAt < PRUNE_INTERVAL_MS) return 0;
  lastPruneAt = now;

  // A device that was deleted — or has simply not beaten in an hour — has no
  // claim on a rate-limit slot, and nothing else ever removes one. Its next
  // beat, if it comes, is worth a sample anyway.
  for (const [deviceId, at] of lastSampleAt) {
    if (now - at > PRUNE_INTERVAL_MS) lastSampleAt.delete(deviceId);
  }

  const settings = await getHubSettings();
  // Retention off means the history goes too, not just that new rows stop —
  // otherwise turning it off leaves the disk exactly as full as it was.
  const cutoffFor = (days: number) =>
    days <= 0 ? new Date(now) : new Date(now - days * 24 * 60 * 60 * 1000);
  // Two cutoffs, one pass: the device history and the scanner history are set
  // separately, so a fleet keeping a month of one and a day of the other gets
  // exactly that rather than the shorter of the two applied to both.
  const cutoff = cutoffFor(settings.metricsRetentionDays);
  const rotomCutoff = cutoffFor(settings.rotomRetentionDays);

  // deleteMany takes no limit, so a batch is "select the ids, then delete
  // those". Every table here is indexed on `at` alone precisely for this. They
  // have different row shapes, and Prisma's delegate types do not unify, so the
  // caller passes in the two calls rather than the delegate.
  const pruneTable = async (
    oldestIds: (take: number) => Promise<{ id: number }[]>,
    removeIds: (ids: number[]) => Promise<{ count: number }>,
  ): Promise<number> => {
    let removed = 0;
    for (;;) {
      const batch = await oldestIds(PRUNE_BATCH);
      if (batch.length === 0) break;
      const { count } = await removeIds(batch.map((row) => row.id));
      removed += count;
      if (batch.length < PRUNE_BATCH) break;
    }
    return removed;
  };

  let deleted = 0;
  try {
    deleted += await pruneTable(
      (take) =>
        prisma.deviceMetricSample.findMany({
          where: { at: { lt: cutoff } },
          select: { id: true },
          take,
        }),
      (ids) => prisma.deviceMetricSample.deleteMany({ where: { id: { in: ids } } }),
    );
    deleted += await pruneTable(
      (take) =>
        prisma.devicePackageMetricSample.findMany({
          where: { at: { lt: cutoff } },
          select: { id: true },
          take,
        }),
      (ids) => prisma.devicePackageMetricSample.deleteMany({ where: { id: { in: ids } } }),
    );
    // Written by the Rotom sync rather than by a heartbeat, and kept on its own
    // clock.
    deleted += await pruneTable(
      (take) =>
        prisma.rotomSample.findMany({
          where: { at: { lt: rotomCutoff } },
          select: { id: true },
          take,
        }),
      (ids) => prisma.rotomSample.deleteMany({ where: { id: { in: ids } } }),
    );
  } catch (err) {
    log.error({ err }, "metric prune failed");
    return deleted;
  }

  if (deleted > 0) {
    log.info({ deleted, cutoff, days: settings.metricsRetentionDays }, "pruned metric samples");
  }
  return deleted;
}
