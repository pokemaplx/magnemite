import { getHubSettings, prisma } from "@magnemite/db";
import {
  MAX_SERIES,
  RANGES,
  type Chart,
  type MetricsView,
  type RangeKey,
  type Series,
  type SeriesStats,
} from "./metrics-view";

/**
 * Reads a box's health history and shapes it for the charts.
 *
 * Everything here runs on the server. The samples are raw — one row per box
 * per `metricsSampleSeconds` — and a week of them is tens of thousands of
 * points, which is both more than a chart can draw and more than is worth
 * sending to a browser. So the window is bucketed to roughly a point per
 * pixel-column before it leaves here, and the summary statistics are computed
 * from the raw rows rather than from the buckets, because an average of
 * averages is not the average.
 */

/** Roughly one bucket per pixel-column of a chart at its usual width. */
const TARGET_BUCKETS = 220;

/**
 * Hard cap on rows read **per series**, not per query.
 *
 * A fleet left on a one-second sample interval for a month would otherwise
 * pull millions of rows into the render; hitting this trims the *oldest* end of
 * the window, and the page says so.
 *
 * Per series is the whole point. It used to be one budget for a whole query,
 * which every series in that query shared: the per-app query carries one
 * series per package, so six apps got a sixth of the window each and the rest
 * of it came back with no rows at all. Empty buckets are drawn as gaps — this
 * project's rule is that a null is a gap and never a zero — so the honest
 * reading of that chart was "nothing ran for the first twenty-five days",
 * which is also exactly what a real outage looks like. 40,000 was already
 * under one series' worth: a single box at the default 60-second interval is
 * 43,200 rows over thirty days.
 */
const MAX_ROWS_PER_SERIES = 50_000;

type Bucket<T> = { sum: number; count: number; extra?: T };

/** Mean of a bucket, or null when nothing landed in it. */
function mean(bucket: Bucket<unknown> | undefined): number | null {
  if (!bucket || bucket.count === 0) return null;
  return bucket.sum / bucket.count;
}

function statsFrom(values: number[], gaps: number, last: number | null): SeriesStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const total = values.reduce((acc, v) => acc + v, 0);
  // Nearest-rank p95, which needs no interpolation and cannot invent a value
  // the box never reported.
  const rank = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return {
    avg: total / values.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    p95: sorted[Math.max(0, rank)]!,
    last,
    gaps,
  };
}

/** The chart-shaped view of one metric: bucket means, plus stats off the raw rows. */
/**
 * Exported for the Rotom history, which buckets a different table into the same
 * chart shape. Nothing in here knows what it is averaging.
 */
export function buildSeries(
  id: string,
  label: string,
  slot: number,
  bucketCount: number,
  rows: { bucket: number; value: number | null }[],
): Series {
  const buckets: (Bucket<never> | undefined)[] = new Array(bucketCount);
  const raw: number[] = [];
  let last: number | null = null;

  for (const row of rows) {
    if (row.value === null || !Number.isFinite(row.value)) continue;
    const slotIndex = row.bucket;
    const existing = buckets[slotIndex];
    if (existing) {
      existing.sum += row.value;
      existing.count += 1;
    } else {
      buckets[slotIndex] = { sum: row.value, count: 1 };
    }
    raw.push(row.value);
    // Rows arrive oldest-first, so the last one wins.
    last = row.value;
  }

  const points = Array.from({ length: bucketCount }, (_, i) => mean(buckets[i]));
  const gaps = points.filter((p) => p === null).length;

  return { id, label, slot, points, stats: statsFrom(raw, gaps, last) };
}

/** Bucket index for a timestamp, clamped into the window. */
export function bucketOf(at: Date, from: number, bucketMs: number, bucketCount: number): number {
  const index = Math.floor((at.getTime() - from) / bucketMs);
  return Math.max(0, Math.min(bucketCount - 1, index));
}

function num(value: number | bigint | null): number | null {
  if (value === null) return null;
  return typeof value === "bigint" ? Number(value) : value;
}

/** Percentage used, from a total and what is free/available. */
function usedPercent(total: number | null, free: number | null): number | null {
  if (total === null || free === null || total <= 0) return null;
  return ((total - free) / total) * 100;
}

export async function loadDeviceMetrics(
  deviceId: string,
  opts: { range: RangeKey; packages: string[] | null },
): Promise<MetricsView> {
  const settings = await getHubSettings();
  const range = RANGES.find((r) => r.key === opts.range) ?? RANGES[2]!;

  const to = Date.now();
  const from = to - range.hours * 60 * 60 * 1000;
  const since = new Date(from);

  // Newest-first with a cap, then reversed: when the cap bites it should cost
  // the oldest end of the window, not the part someone is actually looking at.
  //
  // One budget each, sized by how many series the query feeds. The device-wide
  // query is one row per sample however many charts read it, so one series'
  // worth covers it. The per-app query is one row per sample *per package*, so
  // it gets a series' worth per palette slot — otherwise the charts the page
  // is mostly made of are the ones that lose the oldest weeks.
  const packageRowBudget = MAX_ROWS_PER_SERIES * MAX_SERIES;
  const [deviceRowsDesc, packageRowsDesc] = await Promise.all([
    prisma.deviceMetricSample.findMany({
      where: { deviceId, at: { gte: since } },
      orderBy: { at: "desc" },
      take: MAX_ROWS_PER_SERIES,
      select: {
        at: true,
        loadAvg1: true,
        loadAvg5: true,
        loadAvg15: true,
        cpuCount: true,
        memTotalBytes: true,
        memAvailableBytes: true,
        freeBytes: true,
        totalBytes: true,
        cpuTempC: true,
        batteryTempC: true,
      },
    }),
    prisma.devicePackageMetricSample.findMany({
      where: { deviceId, at: { gte: since } },
      orderBy: { at: "desc" },
      take: packageRowBudget,
      select: { at: true, packageName: true, cpuPercent: true, rssBytes: true },
    }),
  ]);

  const deviceRows = [...deviceRowsDesc].reverse();
  const packageRows = [...packageRowsDesc].reverse();
  // Each query against its own budget. Either one hitting it means the oldest
  // end of the window has no rows behind it, which the page has to keep saying
  // — a trimmed window and a dead fleet draw identically.
  const truncated =
    deviceRowsDesc.length >= MAX_ROWS_PER_SERIES || packageRowsDesc.length >= packageRowBudget;

  // Never finer than the sample interval: buckets narrower than the data are
  // just gaps between single points, which reads as a broken chart.
  const span = to - from;
  const bucketMs = Math.max(
    Math.max(settings.metricsSampleSeconds, 1) * 1000,
    Math.ceil(span / TARGET_BUCKETS),
  );
  const bucketCount = Math.max(1, Math.ceil(span / bucketMs));
  const times = Array.from({ length: bucketCount }, (_, i) => from + i * bucketMs);
  const indexOf = (at: Date) => bucketOf(at, from, bucketMs, bucketCount);

  // --- Device-wide charts --------------------------------------------------

  const loadRows = (pick: (row: (typeof deviceRows)[number]) => number | null) =>
    deviceRows.map((row) => ({ bucket: indexOf(row.at), value: pick(row) }));

  // A load average against the core count is what makes 1.6 mean something:
  // 100% is "fully busy", above it work is queueing. Boxes that never reported
  // a core count keep the raw figure rather than a made-up percentage.
  const loadPercent = (load: number | null, cores: number | null) =>
    load === null || !cores ? null : (load / cores) * 100;

  const cpuChart: Chart = {
    id: "cpu",
    title: "CPU load",
    description:
      "Run-queue average as a share of the box's cores. 100% is fully busy; above it, work is queueing.",
    unit: "percent",
    // No ceiling: a box at 300% is the interesting case and must not clip.
    max: null,
    series: [
      buildSeries(
        "load1",
        "1 min",
        1,
        bucketCount,
        loadRows((row) => loadPercent(row.loadAvg1, row.cpuCount)),
      ),
      buildSeries(
        "load5",
        "5 min",
        2,
        bucketCount,
        loadRows((row) => loadPercent(row.loadAvg5, row.cpuCount)),
      ),
      buildSeries(
        "load15",
        "15 min",
        3,
        bucketCount,
        loadRows((row) => loadPercent(row.loadAvg15, row.cpuCount)),
      ),
    ],
  };

  const memoryChart: Chart = {
    id: "memory",
    title: "Memory used",
    description: "Share of RAM in use, from MemTotal and MemAvailable.",
    unit: "percent",
    max: 100,
    series: [
      buildSeries(
        "memory",
        "Memory",
        1,
        bucketCount,
        loadRows((row) => usedPercent(num(row.memTotalBytes), num(row.memAvailableBytes))),
      ),
    ],
  };

  const storageChart: Chart = {
    id: "storage",
    title: "Storage used",
    description: "Share of /data in use — the partition an install session writes to.",
    unit: "percent",
    max: 100,
    series: [
      buildSeries(
        "storage",
        "Storage",
        1,
        bucketCount,
        loadRows((row) => usedPercent(num(row.totalBytes), num(row.freeBytes))),
      ),
    ],
  };

  const temperatureChart: Chart = {
    id: "temperature",
    title: "Temperature",
    description: "Degrees Celsius off the box's thermal zones.",
    unit: "celsius",
    max: null,
    series: [
      buildSeries(
        "cpuTemp",
        "SoC",
        1,
        bucketCount,
        loadRows((row) => row.cpuTempC),
      ),
      buildSeries(
        "batteryTemp",
        "Battery",
        2,
        bucketCount,
        loadRows((row) => row.batteryTempC),
      ),
    ].filter((series) => series.stats !== null),
  };

  // --- Per-app charts ------------------------------------------------------

  // Sorted by name, not by usage: the sort is what pins each package to a
  // colour slot, and a slot that moved with the ranking would repaint the
  // whole chart every time an app got busier.
  const packages = [...new Set(packageRows.map((row) => row.packageName))].sort();
  const slotOf = new Map(packages.map((name, index) => [name, index + 1]));

  // Default to the three busiest, which is what someone opening the page came
  // to look at — while the colours stay alphabetical.
  const busiest = [...packages]
    .map((name) => {
      const values = packageRows
        .filter((row) => row.packageName === name && row.cpuPercent !== null)
        .map((row) => row.cpuPercent as number);
      const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
      return { name, avg };
    })
    .sort((a, b) => b.avg - a.avg)
    .map((entry) => entry.name);

  const requested = opts.packages?.filter((name) => packages.includes(name)) ?? null;
  const selected = (requested && requested.length > 0 ? requested : busiest.slice(0, 3))
    // Past eight there are no palette slots left, and a ninth hue would be
    // indistinguishable from one already on screen.
    .filter((name) => (slotOf.get(name) ?? MAX_SERIES + 1) <= MAX_SERIES)
    .slice(0, MAX_SERIES);

  const shortLabel = (packageName: string) => packageName.split(".").pop() || packageName;

  const packageSeries = (pick: (row: (typeof packageRows)[number]) => number | null) =>
    selected.map((name) =>
      buildSeries(
        name,
        shortLabel(name),
        slotOf.get(name) ?? 1,
        bucketCount,
        packageRows
          .filter((row) => row.packageName === name)
          .map((row) => ({ bucket: indexOf(row.at), value: pick(row) })),
      ),
    );

  const packageCpuChart: Chart = {
    id: "package-cpu",
    title: "CPU by app",
    description:
      "Share of a single core per app, summed over its processes — 200% is two cores pinned. A gap means the app was not running.",
    unit: "percent",
    max: null,
    series: packageSeries((row) => row.cpuPercent),
  };

  const packageMemoryChart: Chart = {
    id: "package-memory",
    title: "Memory by app",
    description: "Resident set size per app, summed over its processes.",
    unit: "bytes",
    max: null,
    series: packageSeries((row) => num(row.rssBytes)),
  };

  // A chart with nothing in it is worse than no chart: it reads as "this box
  // is at zero" rather than "this box never said".
  const charts = [
    cpuChart,
    memoryChart,
    storageChart,
    temperatureChart,
    packageCpuChart,
    packageMemoryChart,
  ].filter((chart) => chart.series.some((series) => series.stats !== null));

  return {
    times,
    bucketMs,
    from,
    to,
    charts,
    packages,
    selected,
    sampleCount: deviceRows.length,
    truncated,
    retentionDays: settings.metricsRetentionDays,
    sampleSeconds: settings.metricsSampleSeconds,
  };
}

/** The window the sparklines span. */
const TREND_WINDOW_MS = 60 * 60 * 1000;

/**
 * Every row that hour can hold, at one sample a second.
 *
 * Finer than anything that can be configured — `metricsSampleSeconds` cannot
 * go below the heartbeat, and the heartbeat starts at 5s — so this cap cannot
 * bite on the window below, which is the point. `take: 400` could: at a
 * one-second interval it kept the newest 400 samples and the sparkline drew
 * them edge to edge, labelled as an hour, showing six minutes.
 */
const TREND_MAX_ROWS = TREND_WINDOW_MS / 1000;

/**
 * The last hour or so of a metric, for the sparklines on the device page's
 * Load card. Small on purpose: the card is a summary, and the full history is
 * one click away.
 */
export async function loadRecentTrend(
  deviceId: string,
  points = 40,
): Promise<{
  cpu: (number | null)[];
  memory: (number | null)[];
  storage: (number | null)[];
}> {
  const since = new Date(Date.now() - TREND_WINDOW_MS);
  const rows = await prisma.deviceMetricSample.findMany({
    where: { deviceId, at: { gte: since } },
    orderBy: { at: "desc" },
    take: TREND_MAX_ROWS,
    select: {
      loadAvg1: true,
      cpuCount: true,
      memTotalBytes: true,
      memAvailableBytes: true,
      freeBytes: true,
      totalBytes: true,
    },
  });
  if (rows.length === 0) return { cpu: [], memory: [], storage: [] };

  const ordered = [...rows].reverse();
  // Evenly spaced samples rather than the newest N: the sparkline should span
  // the whole hour whatever the sample interval is set to.
  const step = Math.max(1, Math.ceil(ordered.length / points));
  const taken = ordered.filter((_, index) => index % step === 0);

  return {
    cpu: taken.map((row) =>
      row.loadAvg1 === null || !row.cpuCount ? null : (row.loadAvg1 / row.cpuCount) * 100,
    ),
    memory: taken.map((row) => usedPercent(num(row.memTotalBytes), num(row.memAvailableBytes))),
    storage: taken.map((row) => usedPercent(num(row.totalBytes), num(row.freeBytes))),
  };
}
