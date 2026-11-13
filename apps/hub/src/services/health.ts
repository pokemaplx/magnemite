import fs from "node:fs/promises";
import path from "node:path";
import type { SourceFeed } from "@magnemite/db";
import { Prisma, prisma } from "@magnemite/db";
import { getHubSettings, getMonitorSettings } from "./hubSettings.js";
import { env } from "../env.js";
import { log } from "../log.js";
import { connectionCount } from "../registry.js";
import { HUB_VERSION } from "../version.js";
import { agentTargetVersion, agentUpdatesInFlight } from "./agentRelease.js";
import { listDevices, rotomBasicAuthHeader, rotomEnabled } from "./rotom.js";
import { entriesForTarget, fetchFeedIndex } from "./sources/feed.js";
import { getPollStat } from "./sources/poller.js";
import { compareVersions } from "./sources/types.js";

/**
 * "Is every moving part still talking to us" — one probe per integration,
 * answered live rather than read out of the database.
 *
 * `OFF` is deliberately not a failure: a fleet with no Rotom and a source
 * left disabled is a perfectly healthy fleet, and painting those cards red
 * would only teach people to ignore the page.
 */
export type IntegrationState = "OK" | "DEGRADED" | "DOWN" | "OFF";

export type IntegrationFact = { label: string; value: string };

export type IntegrationCheck = {
  key: string;
  label: string;
  /** One line under the title, always present. */
  summary: string;
  state: IntegrationState;
  /** Round trip of the probe itself, when the probe made a call. */
  latencyMs: number | null;
  facts: IntegrationFact[];
  /** Error text when something failed, for the operator to act on. */
  detail: string | null;
  /** Where to go to look at the thing itself. */
  link: string | null;
};

export type HubHealth = {
  checkedAt: string;
  /** The worst state among the checks that are not OFF. */
  overall: IntegrationState;
  checks: IntegrationCheck[];
};

/**
 * Probes are cached. The dashboard re-renders on every fleet event, and
 * every source index is a real network call — not something to spend on
 * repaints. The page's own "Check again" button forces a fresh round.
 */
const CACHE_MS = 30_000;
let cached: { at: number; value: HubHealth } | null = null;

const RANK: Record<IntegrationState, number> = { OK: 0, OFF: 0, DEGRADED: 1, DOWN: 2 };

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const started = Date.now();
  const value = await fn();
  return { ms: Date.now() - started, value };
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

async function checkHub(): Promise<IntegrationCheck> {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const agentTarget = agentTargetVersion();
  const updating = agentUpdatesInFlight();
  const settings = await getHubSettings();
  const monitor = await getMonitorSettings();

  return {
    key: "hub",
    label: "Hub",
    summary: `Running for ${hours > 0 ? `${hours}h ` : ""}${minutes}m`,
    state: "OK",
    latencyMs: null,
    facts: [
      { label: "Hub", value: HUB_VERSION },
      { label: "Node", value: process.version },
      { label: "Device sockets", value: String(connectionCount()) },
      { label: "Concurrent installs", value: String(settings.maxConcurrentJobs) },
      // No fleet-wide poll interval any more: each feed keeps its own, and the
      // Sources card below reports them next to what each one last found.
      ...(rotomEnabled()
        ? [{ label: "Rotom sync", value: `every ${monitor.rotomSyncSeconds}s` }]
        : []),
      { label: "Artifacts served by", value: env.SERVE_ARTIFACTS ? "hub (Node)" : "edge (Caddy)" },
      {
        label: "Agent target",
        value: agentTarget
          ? `${agentTarget}${updating > 0 ? ` · ${updating} updating` : ""}`
          : "auto-update off",
      },
    ],
    detail: null,
    link: null,
  };
}

/**
 * The server's own version, as it reports it.
 *
 * Postgres: `SHOW server_version` rather than `version()` — the latter is a
 * paragraph of build flags, and the number is the part anyone reads. MySQL
 * and MariaDB have no `SHOW server_version`, but `SELECT VERSION()` already
 * returns just the short string (MariaDB's even says so: `10.11.6-MariaDB`).
 */
async function databaseVersion(): Promise<string> {
  try {
    if (env.DB_PROVIDER === "mysql") {
      const rows = await prisma.$queryRaw<{ version: string }[]>`SELECT VERSION() as version`;
      return rows[0]?.version ?? "unknown";
    }
    const rows = await prisma.$queryRaw<{ server_version: string }[]>`SHOW server_version`;
    return rows[0]?.server_version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** The client version, which is what decides the wire protocol it speaks. */
function prismaVersion(): string {
  return Prisma.prismaVersion.client;
}

async function checkDatabase(): Promise<IntegrationCheck> {
  const engine = env.DB_PROVIDER === "mysql" ? "MariaDB/MySQL" : "Postgres";
  try {
    const { ms } = await timed(() => prisma.$queryRaw`SELECT 1`);
    const [devices, versions, jobs, server] = await Promise.all([
      // Boxes. A VPS is a Device too, and counting it here would inflate the
      // only number on this page that is meant to be "the size of the fleet".
      prisma.device.count({ where: { kind: "BOX" } }),
      prisma.appVersion.count(),
      prisma.job.count(),
      databaseVersion(),
    ]);

    return {
      key: "database",
      label: "Database",
      summary: `${engine} answering in ${ms} ms`,
      state: ms > 500 ? "DEGRADED" : "OK",
      latencyMs: ms,
      facts: [
        { label: engine, value: server },
        { label: "Prisma", value: prismaVersion() },
        { label: "Devices", value: String(devices) },
        { label: "Versions", value: String(versions) },
        { label: "Jobs", value: String(jobs) },
      ],
      detail: null,
      link: null,
    };
  } catch (err) {
    return {
      key: "database",
      label: "Database",
      summary: `${engine} is not answering`,
      state: "DOWN",
      latencyMs: null,
      facts: [],
      detail: message(err),
      link: null,
    };
  }
}

async function checkArtifacts(): Promise<IntegrationCheck> {
  try {
    const entries = await fs.readdir(env.ARTIFACT_DIR);
    const bundles = entries.filter((name) => name.endsWith(".apkm"));

    let bytes = 0;
    for (const name of bundles) {
      const stat = await fs.stat(path.join(env.ARTIFACT_DIR, name)).catch(() => null);
      if (stat) bytes += stat.size;
    }

    const stats = await fs.statfs(env.ARTIFACT_DIR).catch(() => null);
    const free = stats ? Number(stats.bavail) * Number(stats.bsize) : null;
    // One bundle is ~170 MB and a rollout may cache several, so under 5 GB the
    // next download is the one that fails.
    const low = free !== null && free < 5 * 1024 ** 3;

    return {
      key: "artifacts",
      label: "Artifact storage",
      summary: low
        ? `Only ${gb(free)} left on the artifacts volume`
        : `${bundles.length} bundle${bundles.length === 1 ? "" : "s"} cached${
            free !== null ? `, ${gb(free)} free` : ""
          }`,
      state: low ? "DEGRADED" : "OK",
      latencyMs: null,
      facts: [
        { label: "Directory", value: env.ARTIFACT_DIR },
        { label: "Cached bundles", value: String(bundles.length) },
        { label: "On disk", value: gb(bytes) },
        ...(free !== null ? [{ label: "Free space", value: gb(free) }] : []),
      ],
      detail: null,
      link: null,
    };
  } catch (err) {
    return {
      key: "artifacts",
      label: "Artifact storage",
      summary: `${env.ARTIFACT_DIR} is not readable`,
      state: "DOWN",
      latencyMs: null,
      facts: [{ label: "Directory", value: env.ARTIFACT_DIR }],
      detail: message(err),
      link: null,
    };
  }
}

/**
 * What the poller last did with a feed, so a card can say when it last
 * actually ran rather than only whether the index is up right now.
 */
function pollFacts(feedId: string): IntegrationFact[] {
  const stat = getPollStat(feedId);
  if (!stat) return [{ label: "Last poll", value: "not since the hub started" }];

  return [
    { label: "Last poll", value: stat.at },
    {
      label: "Last result",
      value: stat.ok ? `${stat.found} version${stat.found === 1 ? "" : "s"} listed` : "failed",
    },
  ];
}

/**
 * One card per configured feed.
 *
 * Every feed publishes the same index shape, so the check is the same for all
 * of them: fetch it, count what matches the target, and report the newest
 * build listed. A feed that answers but lists nothing for this package is
 * degraded rather than down — that is usually a wrong URL, not an outage.
 */
async function checkFeeds(): Promise<IntegrationCheck[]> {
  const [feeds, target] = await Promise.all([
    prisma.sourceFeed.findMany({ orderBy: { priority: "asc" } }),
    prisma.appTarget.findFirst({
      where: { enabled: true, manual: false },
      select: { packageName: true, arch: true },
    }),
  ]);

  if (feeds.length === 0) {
    return [
      {
        key: "feeds",
        label: "Version sources",
        summary: "No source feed is configured",
        state: "OFF",
        latencyMs: null,
        facts: [],
        detail: "Add one in Settings → Version sources.",
        link: null,
      },
    ];
  }

  return Promise.all(feeds.map((feed) => checkFeed(feed, target)));
}

async function checkFeed(
  feed: SourceFeed,
  target: { packageName: string; arch: string } | null,
): Promise<IntegrationCheck> {
  const key = `feed:${feed.id}`;
  const stat = getPollStat(feed.id);

  if (!feed.enabled) {
    return {
      key,
      label: feed.name,
      summary: "Disabled — not polled",
      state: "OFF",
      latencyMs: null,
      facts: [{ label: "Index", value: feed.indexUrl }],
      detail: null,
      link: feed.indexUrl,
    };
  }

  try {
    const { ms, value: entries } = await timed(() => fetchFeedIndex(feed.indexUrl, 15_000));
    const ours = target ? entriesForTarget(entries, target) : entries;
    // The index is in upload order, not version order, so the last line is
    // not the newest build.
    const newest =
      ours
        .map((e) => e.version)
        .filter((v): v is string => Boolean(v))
        .sort(compareVersions)
        .at(-1) ?? null;

    const usable = ours.filter((e) => e.url || feed.baseUrl).length;
    const unusable = ours.length - usable;

    return {
      key,
      label: feed.name,
      summary:
        ours.length === 0
          ? `Index is up but lists nothing for ${target?.packageName ?? "the watched app"}`
          : `${ours.length} build${ours.length === 1 ? "" : "s"} listed for this target`,
      state: ours.length === 0 || unusable > 0 || (stat && !stat.ok) ? "DEGRADED" : "OK",
      latencyMs: ms,
      facts: [
        { label: "Index", value: feed.indexUrl },
        { label: "Base URL", value: feed.baseUrl ?? "absolute URLs in the index" },
        { label: "Priority", value: String(feed.priority) },
        { label: "Entries", value: `${ours.length} of ${entries.length}` },
        ...(newest ? [{ label: "Newest listed", value: newest }] : []),
        ...pollFacts(feed.id),
      ],
      detail:
        unusable > 0
          ? `${unusable} entries have no download URL: this index publishes relative filenames, so the feed needs a base URL.`
          : stat && !stat.ok
            ? stat.error
            : null,
      link: feed.indexUrl,
    };
  } catch (err) {
    return {
      key,
      label: feed.name,
      summary: "The index did not answer",
      state: "DOWN",
      latencyMs: null,
      facts: [{ label: "Index", value: feed.indexUrl }, ...pollFacts(feed.id)],
      detail: message(err),
      link: feed.indexUrl,
    };
  }
}

/** "1.4.2 ×37, 1.4.1 ×3" — most common first, so the outliers stand out. */
function workerVersions(devices: { version?: string | null }[]): string {
  const counts = new Map<string, number>();
  for (const device of devices) {
    const version = device.version?.trim() || "unknown";
    counts.set(version, (counts.get(version) ?? 0) + 1);
  }
  if (counts.size === 0) return "—";

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([version, count]) => `${version} ×${count}`)
    .join(", ");
}

async function checkRotom(): Promise<IntegrationCheck> {
  if (!rotomEnabled()) {
    return {
      key: "rotom",
      label: "Rotom",
      summary: "Offline, integration disabled",
      state: "OFF",
      latencyMs: null,
      facts: [
        { label: "ROTOM_ENABLED", value: String(env.ROTOM_ENABLED) },
        { label: "ROTOM_URL", value: env.ROTOM_URL ?? "not set" },
      ],
      detail: null,
      link: null,
    };
  }

  try {
    const { ms, value: devices } = await timed(() => listDevices());
    const connected = devices.filter((d) => d.is_connected).length;
    const matched = await prisma.device.count({
      where: { kind: "BOX", rotomDeviceId: { not: null } },
    });
    // Rotom listing boxes that never match one of ours means the origins do
    // not line up, and the install lifecycle then silently does nothing.
    const unmatched = devices.length > 0 && matched === 0;

    return {
      key: "rotom",
      label: "Rotom",
      summary: `${connected} of ${devices.length} scanner${devices.length === 1 ? "" : "s"} connected`,
      state: unmatched ? "DEGRADED" : "OK",
      latencyMs: ms,
      facts: [
        { label: "URL", value: env.ROTOM_URL ?? "—" },
        { label: "Secret", value: env.ROTOM_SECRET ? "set" : "none" },
        // Which of the two credentials is in play, since a 401 looks the
        // same either way: the proxy rejecting BasicAuth and Rotom
        // rejecting the secret are both just HTTP 401 here.
        {
          label: "Basic auth",
          value: rotomBasicAuthHeader() ? `as ${env.ROTOM_BASIC_USERNAME}` : "none",
        },
        { label: "Devices listed", value: String(devices.length) },
        { label: "Matched to our fleet", value: String(matched) },
        // The scanner's own version, which Magnemite never installs and so
        // never otherwise reports. A fleet halfway through a scanner update
        // shows up here as two numbers.
        { label: "Worker versions", value: workerVersions(devices) },
      ],
      detail: unmatched
        ? "No Rotom device matches one of magnemite's. Check each box's id in Rotom against its name."
        : null,
      link: env.ROTOM_URL ?? null,
    };
  } catch (err) {
    return {
      key: "rotom",
      label: "Rotom",
      summary: "Enabled, but not answering",
      state: "DOWN",
      latencyMs: null,
      facts: [{ label: "URL", value: env.ROTOM_URL ?? "—" }],
      detail: message(err),
      link: env.ROTOM_URL ?? null,
    };
  }
}

async function checkEdge(): Promise<IntegrationCheck> {
  const base = env.MAGNEMITE_PUBLIC_URL.replace(/\/$/, "");

  try {
    const { ms, value: res } = await timed(() =>
      fetch(`${base}/healthz`, { signal: AbortSignal.timeout(10_000) }),
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    return {
      key: "edge",
      label: "Public edge",
      summary: `The address the boxes use answers in ${ms} ms`,
      state: "OK",
      latencyMs: ms,
      facts: [
        { label: "Public URL", value: base },
        // Whatever is actually answering on that URL. Usually our own Caddy,
        // but on a deployment fronted by someone else's proxy this is the
        // quickest way to see whose it is.
        { label: "Served by", value: res.headers.get("server") ?? "unidentified" },
        { label: "Artifacts", value: `${base}/files/` },
      ],
      detail: null,
      link: base,
    };
  } catch (err) {
    return {
      key: "edge",
      label: "Public edge",
      summary: "The address the boxes use is not answering from in here",
      state: "DOWN",
      latencyMs: null,
      facts: [{ label: "Public URL", value: base }],
      // Worth spelling out: this URL is handed to every agent, so a failure
      // here is every enrolment and every download failing.
      detail: `${message(err)} — enrolment and artifact downloads use this URL.`,
      link: null,
    };
  }
}

// ---------------------------------------------------------------------------

export async function collectHealth(force = false): Promise<HubHealth> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  const [core, feeds] = await Promise.all([
    Promise.all([checkHub(), checkDatabase(), checkArtifacts(), checkRotom(), checkEdge()]),
    checkFeeds(),
  ]);
  // Feeds sit between the local checks and the integrations that depend on
  // them, which is the order they matter in when something is broken.
  const checks = [...core.slice(0, 3), ...feeds, ...core.slice(3)];

  const overall = checks.reduce<IntegrationState>(
    (worst, check) => (RANK[check.state] > RANK[worst] ? check.state : worst),
    "OK",
  );

  const value: HubHealth = { checkedAt: new Date().toISOString(), overall, checks };
  cached = { at: Date.now(), value };

  const failing = checks.filter((c) => c.state === "DOWN" || c.state === "DEGRADED");
  if (failing.length > 0) {
    log.warn({ failing: failing.map((c) => `${c.key}:${c.state}`) }, "integration health degraded");
  }

  return value;
}
