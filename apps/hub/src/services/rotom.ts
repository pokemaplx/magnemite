import { prisma } from "@magnemite/db";
import { z } from "zod";
import { bus } from "../bus.js";
import { env } from "../env.js";
import { log } from "../log.js";
import { getHubSettings, getMonitorSettings } from "./hubSettings.js";

/**
 * RotomNG integration.
 *
 * Rotom is the thing that actually knows whether a box is scanning, which
 * makes it a health signal Magnemite cannot produce on its own — a box can be
 * online, heartbeating, and handing Rotom nothing.
 *
 * That is now the whole of it. Rotom used to be wired into installs as well:
 * the box was disabled before one and re-enabled after, and "did the update
 * work" was answered by it reappearing with live workers. That coupling is
 * gone. It made every rollout depend on a second service being reachable and
 * agreeing, and the install pipeline has its own verification. What is left is
 * three things, all read-only or operator-driven:
 *
 *  - `syncDevices` keeps each box's scanning state current, on the interval
 *    set in Settings → Tuning;
 *  - monitoring reads that state as the `ROTOM_DISCONNECTED`,
 *    `ROTOM_NOT_SCANNING` and `ROTOM_IDLE` signals, and can restart, drop or
 *    reboot a box through Rotom as a remediation;
 *  - the device page offers the same actions by hand.
 *
 * API reference: https://github.com/UnownHash/RotomNG/blob/main/docs/RotomNG-API.md
 */

// ---------------------------------------------------------------------------
// The shape Rotom answers with
// ---------------------------------------------------------------------------

/**
 * Parsed rather than cast.
 *
 * The whole fleet's scanning state comes out of this one response, and the
 * sweep at the bottom of `syncDevices` marks boxes offline on the strength of
 * it. Read with a cast, a renamed field turns into `Boolean(undefined)` — a
 * confident *false* — and the fleet is declared disconnected in one pass. Every
 * field below is therefore optional and a device that does not parse is
 * skipped, so the failure mode of a Rotom that changed shape is silence rather
 * than a fleet-wide fault.
 */
const timeWindowedStatsSchema = z.object({
  requests_rate_over_30_seconds: z.number().nullish(),
  requests_rate_over_1_min: z.number().nullish(),
  requests_rate_over_5_min: z.number().nullish(),
  requests_rate_over_15_min: z.number().nullish(),
  request_ms_avg_over_30_seconds: z.number().nullish(),
  request_ms_avg_over_1_min: z.number().nullish(),
  request_ms_avg_over_5_min: z.number().nullish(),
  request_ms_avg_over_15_min: z.number().nullish(),
});

const rotomWorkerSchema = z.object({
  id: z.string(),
  device_id: z.string().nullish(),
  origin: z.string().nullish(),
  version_name: z.string().nullish(),
  version_code: z.number().nullish(),
  user_agent: z.string().nullish(),
  platform: z.string().nullish(),
  weight: z.number().nullish(),
  is_connected: z.boolean().nullish(),
  is_in_use: z.boolean().nullish(),
  can_be_used: z.boolean().nullish(),
  last_seen_at_ms: z.number().nullish(),
  /**
   * Only present when Rotom is in a mode that measures: `requests`, or `proxy`
   * with `inspect`. Absent is not zero — see `summariseWorkers`.
   */
  time_windowed_stats: timeWindowedStatsSchema.nullish(),
  session: z
    .object({
      controller: z
        .object({
          id: z.string().nullish(),
          uuid: z.string().nullish(),
          // Which build is driving this worker — "Dragonite/1.20.10-testing"
          // and the like. The worker reports its own scanner version; this is
          // the thing on the other end of it.
          user_agent: z.string().nullish(),
          account_username: z.string().nullish(),
          account_source: z.string().nullish(),
          weight: z.number().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

const rotomDeviceSchema = z.object({
  id: z.string(),
  origin: z.string().nullish(),
  version: z.string().nullish(),
  public_ip: z.string().nullish(),
  worker_count: z.number().nullish(),
  worker_in_use_count: z.number().nullish(),
  last_connected_at_ms: z.number().nullish(),
  last_seen_at_ms: z.number().nullish(),
  enabled: z.boolean().nullish(),
  is_connected: z.boolean().nullish(),
  can_be_used: z.boolean().nullish(),
  is_in_use: z.boolean().nullish(),
  last_memory: z
    .object({
      free: z.number().nullish(),
      mitm: z.number().nullish(),
      start: z.number().nullish(),
    })
    .nullish(),
  workers: z.array(rotomWorkerSchema).nullish(),
});

export type RotomWorker = z.infer<typeof rotomWorkerSchema>;
export type RotomDevice = z.infer<typeof rotomDeviceSchema>;

export type RotomAction =
  | "restart" // restart the scanner app
  | "reboot" // reboot the box
  | "disconnect" // drop Rotom's socket to the box and all its workers
  | "disable"
  | "enable"
  | "delete";

export function rotomEnabled(): boolean {
  return env.ROTOM_ENABLED && Boolean(env.ROTOM_URL);
}

/**
 * BasicAuth for a reverse proxy sitting in front of Rotom, from
 * `ROTOM_BASIC_USERNAME` / `ROTOM_BASIC_PASSWORD`.
 *
 * This is a separate axis from `ROTOM_SECRET`, not an alternative spelling of
 * it: the proxy checks `Authorization`, Rotom checks `X-Rotom-Secret`, and a
 * Rotom published behind a gated proxy checks both. Whatever is set gets sent,
 * so all three shapes work without a mode flag to get wrong.
 *
 * A username with no password is a real configuration (BasicAuth allows an
 * empty password), so only a missing username means "not configured".
 */
export function rotomBasicAuthHeader(): string | null {
  const username = env.ROTOM_BASIC_USERNAME;
  if (!username) return null;
  const password = env.ROTOM_BASIC_PASSWORD ?? "";
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function apiUrl(path: string): string {
  const base = (env.ROTOM_URL ?? "").replace(/\/$/, "");
  // Tolerate ROTOM_URL being given with or without the /api suffix.
  const root = base.endsWith("/api") ? base : `${base}/api`;
  return `${root}${path}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (env.ROTOM_SECRET) headers["X-Rotom-Secret"] = env.ROTOM_SECRET;
  const basic = rotomBasicAuthHeader();
  if (basic) headers["Authorization"] = basic;
  if (init?.body) headers["Content-Type"] = "application/json";

  const res = await fetch(apiUrl(path), {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string>) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`rotom ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Every device Rotom knows about, workers included.
 *
 * Throws when the envelope itself is wrong, so a Rotom answering something
 * other than a device list is a *poll failure* rather than an empty fleet.
 * Individual devices that do not parse are dropped with a warning, which is the
 * conservative half of the same rule: one box Magnemite cannot read is one box
 * it says nothing about.
 */
export async function listDevices(): Promise<RotomDevice[]> {
  const body = await request<unknown>("/device?include_workers=true");
  const envelope = z.object({ devices: z.array(z.unknown()).nullish() }).safeParse(body);
  if (!envelope.success) {
    throw new Error("rotom /device: the response is not a device list");
  }

  const devices: RotomDevice[] = [];
  for (const entry of envelope.data.devices ?? []) {
    const parsed = rotomDeviceSchema.safeParse(entry);
    if (!parsed.success) {
      log.warn(
        { issues: parsed.error.issues.slice(0, 3) },
        "rotom listed a device this hub cannot read; skipping it",
      );
      continue;
    }
    devices.push(parsed.data);
  }
  return devices;
}

/**
 * The last poll's workers, per device, held in memory.
 *
 * The fleet poll already asks for `include_workers=true` and gets every worker
 * of every box; it used to fold them into three numbers and throw the rows
 * away, and the device page then went and fetched the same rows again, one box
 * at a time, on every re-render. That second read was the whole cost: it was a
 * call to somebody else's service driven by a page being open, and the page
 * re-renders on the fleet's own event feed — during a rollout, up to once a
 * second, over events that had nothing to do with that box.
 *
 * Rotom's own dashboard does not have this problem because it never had the
 * second read: it polls `/api/status` once and every view selects out of that
 * one response. This is the same idea one layer down — keep what the poll
 * already brought, and serve the page from it.
 *
 * Deliberately not persisted, for the reason `monitor.ts` gives about its
 * readings: it is the answer to "what is on this box right now", it is replaced
 * every sync, and a restart empties it for as long as one sync takes.
 */
const workersByDevice = new Map<string, { at: number; workers: RotomWorker[] }>();

/** What the last sync saw on one box, or null if it has not seen it yet. */
export function cachedWorkers(deviceId: string): { at: number; workers: RotomWorker[] } | null {
  return workersByDevice.get(deviceId) ?? null;
}

/**
 * By worker id, so the table holds still.
 *
 * Rotom's response carries no ordering anyone can rely on, and it came back
 * shuffled between one sync and the next — eight rows that swapped places every
 * few seconds, which makes the column impossible to read down and makes a table
 * that changed nothing look like it changed everything.
 *
 * Numeric collation rather than a plain string compare: these are ids like
 * `POKELX01-7`, and lexicographically `-10` sorts between `-1` and `-2`.
 * Sorted here rather than in the page so every reader of the cache gets the
 * same order, and sorted on a copy because the array is Rotom's response and
 * the summary above has already read it.
 */
function byWorkerId(workers: RotomWorker[] | null | undefined): RotomWorker[] {
  return [...(workers ?? [])].sort((a, b) =>
    a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" }),
  );
}

export async function deviceAction(rotomDeviceId: string, action: RotomAction): Promise<boolean> {
  try {
    await request(`/device/${encodeURIComponent(rotomDeviceId)}/action/${action}`, {
      method: "PUT",
    });
    return true;
  } catch (err) {
    log.warn({ err, rotomDeviceId, action }, "rotom action failed");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Syncing
// ---------------------------------------------------------------------------

/**
 * Match a Rotom device to one of ours.
 *
 * `id` is the identity: the handle the box registered under and the one the
 * action endpoints take. `origin` is *not* a name — the API gives it as the
 * address Rotom sees the box connect from — so it is matched as an address or
 * not at all. Comparing it against a device name is how a whole fleet ends up
 * with no Scanner column while both sides are working perfectly.
 *
 * Addresses only decide it when exactly one box is a candidate: several boxes
 * behind one NAT share a public IP, and a LAN hands the same address out again
 * after a lease expires.
 */
function matchDevice(rotom: RotomDevice, ours: OurDevice[]): string | null {
  const rotomId = rotom.id;
  const byId =
    ours.find((d) => d.rotomDeviceId === rotomId) ??
    ours.find((d) => d.name === rotomId) ??
    ours.find((d) => d.serial === rotomId) ??
    ours.find((d) => d.name.toLowerCase() === rotomId?.toLowerCase());
  if (byId) return byId.id;

  const byAddress = (
    address: string | null | undefined,
    ourAddress: (d: OurDevice) => string | null,
  ) => {
    if (!address) return null;
    const candidates = ours.filter((d) => ourAddress(d) === address);
    return candidates.length === 1 ? candidates[0]!.id : null;
  };

  return byAddress(rotom.origin, (d) => d.localIp) ?? byAddress(rotom.public_ip, (d) => d.publicIp);
}

/** The Rotom half of a device row: everything the sync owns. */
type RotomState = {
  rotomOrigin: string | null;
  rotomDeviceId: string | null;
  rotomConnected: boolean;
  rotomWorkerCount: number | null;
  rotomLastSeenAt: Date | null;
  rotomEnabled: boolean;
  rotomCanBeUsed: boolean;
  rotomWorkersInUse: number | null;
  rotomInUse: boolean;
  rotomVersion: string | null;
  rotomRequestRate: number | null;
  rotomRequestMs: number | null;
  rotomStatWorkers: number | null;
};

type OurDevice = RotomState & {
  id: string;
  name: string;
  serial: string;
  localIp: string | null;
  publicIp: string | null;
};

const OUR_SELECT = {
  id: true,
  name: true,
  serial: true,
  localIp: true,
  publicIp: true,
  rotomOrigin: true,
  rotomDeviceId: true,
  rotomConnected: true,
  rotomWorkerCount: true,
  rotomLastSeenAt: true,
  rotomEnabled: true,
  rotomCanBeUsed: true,
  rotomWorkersInUse: true,
  rotomInUse: true,
  rotomVersion: true,
  rotomRequestRate: true,
  rotomRequestMs: true,
  rotomStatWorkers: true,
} as const;

/** Two decimals, so a rate that jitters in the third one is not a database write. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The workers of one box, folded into the three numbers that get stored.
 *
 * The important part is what happens when nobody reports: **null, not zero**.
 * Rotom only measures request rates in `requests` mode, or `proxy` mode with
 * `inspect`, so a fleet on any other mode sends workers with no stats at all.
 * Reading that as zero would make every box on such a Rotom permanently idle,
 * which is the same mistake as returning `false` from `readSignal` where `null`
 * was meant. The mean is weighted by each worker's rate, because a worker doing
 * ten requests a second says more about the box than one doing a tenth of one.
 */
function summariseWorkers(workers: RotomWorker[] | null | undefined): {
  rate: number | null;
  ms: number | null;
  reporting: number | null;
} {
  if (!workers || workers.length === 0) return { rate: null, ms: null, reporting: null };

  let rate = 0;
  let weightedMs = 0;
  let weight = 0;
  let reporting = 0;

  for (const worker of workers) {
    const stats = worker.time_windowed_stats;
    const workerRate = stats?.requests_rate_over_5_min;
    if (typeof workerRate !== "number") continue;
    reporting++;
    rate += workerRate;

    const ms = stats?.request_ms_avg_over_5_min;
    if (typeof ms === "number" && workerRate > 0) {
      weightedMs += ms * workerRate;
      weight += workerRate;
    }
  }

  if (reporting === 0) return { rate: null, ms: null, reporting: null };
  return {
    rate: round2(rate),
    // Every reporting worker at zero leaves no weight to average with, and a
    // duration for requests nobody made is not a number worth inventing.
    ms: weight > 0 ? round2(weightedMs / weight) : null,
    reporting,
  };
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

/**
 * Everything except when Rotom last heard from the box.
 *
 * `last_seen_at_ms` moves on every message a healthy box sends, so it changes
 * on essentially every pass and tells a dashboard nothing it can render. It is
 * still written — the staleness half of `ROTOM_DISCONNECTED` reads it — but it
 * does not earn an SSE event for every box on the fleet every minute.
 */
function sameVisibleState(current: RotomState, next: RotomState): boolean {
  return (
    current.rotomOrigin === next.rotomOrigin &&
    current.rotomDeviceId === next.rotomDeviceId &&
    current.rotomConnected === next.rotomConnected &&
    current.rotomWorkerCount === next.rotomWorkerCount &&
    current.rotomEnabled === next.rotomEnabled &&
    current.rotomCanBeUsed === next.rotomCanBeUsed &&
    current.rotomWorkersInUse === next.rotomWorkersInUse &&
    current.rotomInUse === next.rotomInUse &&
    current.rotomVersion === next.rotomVersion &&
    current.rotomRequestRate === next.rotomRequestRate &&
    current.rotomRequestMs === next.rotomRequestMs &&
    current.rotomStatWorkers === next.rotomStatWorkers
  );
}

/**
 * How many passes in a row a box has to be missing from Rotom's list before it
 * is called disconnected.
 *
 * houndour's `deathCount`, and for the same reason: one poll is one opinion. A
 * Rotom mid-restart, a proxy that dropped a request, a device list rebuilt in
 * the moment we asked — each of those is a single bad pass, and without this
 * the monitor sees a fleet-wide outage and starts acting on it before the next
 * sync can disagree. A constant rather than a setting: two is the smallest
 * number that distinguishes a blip from a trend, and no fleet wants a different
 * one badly enough to be asked.
 */
const MISSES_BEFORE_OFFLINE = 2;

/** Consecutive passes each device has been missing. In memory: a hub restart
 *  forgets them, and `startupGraceSeconds` already covers that window. */
const misses = new Map<string, number>();

export async function syncDevices(): Promise<{ seen: number; matched: number }> {
  if (!rotomEnabled()) return { seen: 0, matched: 0 };

  let devices: RotomDevice[];
  try {
    devices = await listDevices();
  } catch (err) {
    log.warn({ err, url: env.ROTOM_URL }, "rotom poll failed");
    return { seen: 0, matched: 0 };
  }

  // Boxes only. `matchDevice` below matches on the device *name* against
  // Rotom's id, and a host named `hel-01` -- the obvious convention once there
  // are several machines -- would otherwise be handed a scanner's identity,
  // a Scanner column and a RotomSample history it can never satisfy.
  const ours = (await prisma.device.findMany({
    where: { kind: "BOX" },
    select: OUR_SELECT,
  })) as OurDevice[];

  // An empty list from a Rotom that answered fine is ambiguous — a genuinely
  // empty fleet, or a Rotom that has not rebuilt its device list yet. Acting on
  // it would mark every box disconnected at once, so it is treated as silence.
  const everMatched = ours.filter((device) => device.rotomDeviceId !== null).length;
  if (devices.length === 0 && everMatched > 0) {
    log.warn(
      { everMatched },
      "rotom listed no devices at all; leaving the fleet as it was rather than marking it offline",
    );
    return { seen: 0, matched: 0 };
  }

  const matchedIds = new Set<string>();
  /** What each matched box now looks like, for the history row below. */
  const believed = new Map<string, RotomState>();
  for (const rotomDevice of devices) {
    const deviceId = matchDevice(rotomDevice, ours);
    if (!deviceId) continue;
    matchedIds.add(deviceId);

    const stats = summariseWorkers(rotomDevice.workers);
    // Kept whole as well as summarised: the three numbers are what a rule acts
    // on, the rows are what the scanner page draws, and both came out of this
    // one response.
    workersByDevice.set(deviceId, { at: Date.now(), workers: byWorkerId(rotomDevice.workers) });
    const next: RotomState = {
      // The address Rotom sees, kept for the device page and the config
      // placeholder. The identity is `id`; this is where the box connects
      // from, and two boxes can share it.
      rotomOrigin: rotomDevice.origin ?? null,
      rotomDeviceId: rotomDevice.id,
      rotomConnected: Boolean(rotomDevice.is_connected),
      rotomWorkerCount: rotomDevice.worker_count ?? null,
      rotomLastSeenAt: rotomDevice.last_seen_at_ms ? new Date(rotomDevice.last_seen_at_ms) : null,
      // Rotom has no single "healthy" field; the composite is
      // enabled && is_connected && can_be_used. Absent means true for
      // `enabled`, since a Rotom too old to report it has no way to be
      // disabled either.
      rotomEnabled: rotomDevice.enabled ?? true,
      rotomCanBeUsed: Boolean(rotomDevice.can_be_used),
      rotomWorkersInUse: rotomDevice.worker_in_use_count ?? null,
      rotomInUse: Boolean(rotomDevice.is_in_use),
      rotomVersion: rotomDevice.version ?? null,
      rotomRequestRate: stats.rate,
      rotomRequestMs: stats.ms,
      rotomStatWorkers: stats.reporting,
    };

    believed.set(deviceId, next);
    await write(ours, deviceId, next);
  }

  const flipped = await sweep(ours, matchedIds);
  await record(ours, believed, flipped);

  log.debug({ seen: devices.length, matched: matchedIds.size }, "rotom sync");
  return { seen: devices.length, matched: matchedIds.size };
}

/**
 * The slot the last history row was written in, so a sync that comes round
 * faster than the sample interval does not write one.
 *
 * Anchored to the clock rather than measured from the previous write, for the
 * reason the metric sampler spells out at length: measuring "has it been a
 * minute since the last one I kept" restarts the wait from wherever the network
 * happened to put the sync, and at a sample interval that is a multiple of the
 * sync — 60 and 10, the defaults — that lands the comparison exactly on the
 * boundary and drops about half the slots.
 *
 * In memory, so a hub restart forgets it and the next sync writes whatever slot
 * it lands in. The worst that costs is one extra row per box per restart, which
 * is the same trade the metric sampler makes — and very visible under
 * `tsx watch`, where every file save is a restart.
 */
let lastRecordedSlot = -1;

/**
 * One history row per box, on the metric sample grid.
 *
 * Not per sync: the sync runs every ten seconds so the Scanner column and the
 * rules are current, and history at that rate would be six rows a minute per
 * box to draw a chart that buckets them back down again. It rides
 * `rotomSampleSeconds`, whose floor is the sync interval rather than the
 * heartbeat — this history has nothing to do with how often a box beats.
 *
 * Written for every box Rotom has ever matched, not only the ones it listed
 * this pass: a box Rotom has dropped is the case worth being able to see
 * afterwards, and it would be a gap rather than a fault if silence were the
 * only thing recorded. What is written is what the rest of the hub now believes
 * — including during the miss debounce, where the belief is still "connected"
 * and every rule is acting on that. A history that disagreed with what was
 * acted on would be worse than none.
 *
 * Written whether or not anything changed, unlike the device row: a flat line
 * is a reading, and the gaps have to keep meaning "nobody asked".
 */
async function record(
  ours: OurDevice[],
  believed: Map<string, RotomState>,
  flipped: Set<string>,
): Promise<void> {
  const settings = await getHubSettings();
  // Its own retention, not the device metrics one: a fleet can want a month of
  // scanner history and a day of load, or the other way round.
  if (settings.rotomRetentionDays <= 0) return;

  const everyMs = Math.max(settings.rotomSampleSeconds, 1) * 1000;
  const slot = Math.floor(Date.now() / everyMs);
  if (slot === lastRecordedSlot) return;
  // Claimed before the await, so two syncs that overlap cannot both decide they
  // are the one to write this slot.
  lastRecordedSlot = slot;

  const at = new Date();
  const rows = ours
    .filter((device) => device.rotomDeviceId !== null)
    .map((device) => {
      const state = believed.get(device.id) ?? device;
      const connected = flipped.has(device.id) ? false : state.rotomConnected;
      return {
        deviceId: device.id,
        at,
        connected,
        enabled: state.rotomEnabled,
        canBeUsed: connected && state.rotomCanBeUsed,
        inUse: connected && state.rotomInUse,
        workerCount: connected ? state.rotomWorkerCount : null,
        workersInUse: connected ? state.rotomWorkersInUse : null,
        requestRate: connected ? state.rotomRequestRate : null,
        requestMs: connected ? state.rotomRequestMs : null,
      };
    });
  if (rows.length === 0) return;

  try {
    await prisma.rotomSample.createMany({ data: rows });
  } catch (err) {
    // History is nice to have; the fleet's scanning state is not. The same
    // trade the metric sampler makes, for the same reason.
    log.warn({ err, rows: rows.length }, "failed to store rotom samples");
  }
}

/** Write and announce a device's Rotom state, both only when they are worth it. */
async function write(ours: OurDevice[], deviceId: string, next: RotomState): Promise<void> {
  const current = ours.find((device) => device.id === deviceId);
  const visiblyChanged = !current || !sameVisibleState(current, next);
  const lastSeenChanged = !current || !sameInstant(current.rotomLastSeenAt, next.rotomLastSeenAt);
  if (!visiblyChanged && !lastSeenChanged) return;

  await prisma.device.update({ where: { id: deviceId }, data: next });
  if (visiblyChanged) bus.publish({ kind: "device", deviceId });
}

/**
 * Boxes Rotom stopped listing.
 *
 * Only after `MISSES_BEFORE_OFFLINE` passes in a row, and only for boxes that
 * were connected — one Rotom never knew about has nothing to lose. Everything
 * measured is cleared rather than frozen: a rate from before Rotom lost the box
 * is not the rate now, and leaving it would let `ROTOM_IDLE` read a ghost.
 *
 * Returns the boxes it actually flipped, so the history row written afterwards
 * says the same thing the device row now does.
 */
async function sweep(ours: OurDevice[], matchedIds: Set<string>): Promise<Set<string>> {
  const flipped = new Set<string>();

  for (const device of ours) {
    if (matchedIds.has(device.id) || !device.rotomConnected) {
      misses.delete(device.id);
      continue;
    }

    const count = (misses.get(device.id) ?? 0) + 1;
    if (count < MISSES_BEFORE_OFFLINE) {
      misses.set(device.id, count);
      log.debug({ deviceId: device.id, count }, "rotom did not list a box; waiting for one more");
      continue;
    }
    misses.delete(device.id);
    flipped.add(device.id);
    // A box Rotom stopped listing has no workers to show. Dropping the entry
    // rather than emptying it is the difference the page needs: nothing cached
    // reads as "no reading", an empty array as "Rotom says none".
    workersByDevice.delete(device.id);

    await prisma.device.update({
      where: { id: device.id },
      data: {
        rotomConnected: false,
        rotomCanBeUsed: false,
        rotomInUse: false,
        rotomWorkersInUse: null,
        rotomRequestRate: null,
        rotomRequestMs: null,
        rotomStatWorkers: null,
      },
    });
    bus.publish({ kind: "device", deviceId: device.id });
  }

  return flipped;
}

// ---------------------------------------------------------------------------
// The sync loop
// ---------------------------------------------------------------------------

/**
 * How often the interval itself is reconsidered. The same shape the source
 * poller uses, and for the same reason: the period is a live setting, so a
 * fixed `setInterval` set up at boot would keep the old one until a restart.
 *
 * A second, not ten. The tick is the resolution of every period above it, so it
 * has to be well under the smallest one the form accepts — at a tick equal to
 * the period, arrival jitter makes about half the checks land a millisecond
 * early, and each rejection pushes the sync a whole tick later. Costing a
 * wake-up a second buys a `rotomSyncSeconds` that means what it says down to
 * the five the form floors it at; the wake-up itself reads a cached object and
 * usually returns immediately.
 */
const CHECK_INTERVAL_MS = 1_000;

let timer: NodeJS.Timeout | null = null;
let lastSyncedAt = 0;

async function maybeSync() {
  // Behind `void maybeSync()`, so anything that escapes here — reading the
  // settings included — would be an unhandled rejection.
  try {
    const settings = await getMonitorSettings();
    if (Date.now() - lastSyncedAt < settings.rotomSyncSeconds * 1000) return;
    lastSyncedAt = Date.now();
    await syncDevices();
  } catch (err) {
    log.error({ err }, "rotom sync failed");
  }
}

export function startRotomSync(): void {
  if (timer) return;
  // The timer runs whether or not Rotom is configured: `syncDevices` returns
  // immediately when it is not, and starting it unconditionally means turning
  // the integration on is one restart rather than a special case here.
  timer = setInterval(() => void maybeSync(), CHECK_INTERVAL_MS);
  if (!rotomEnabled()) return;

  log.info({ url: env.ROTOM_URL }, "rotom integration enabled");
  // Once up front, so the Scanner column is populated on a fresh hub rather
  // than after the first interval.
  void maybeSync();
}

export function stopRotomSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
  misses.clear();
  workersByDevice.clear();
  lastRecordedSlot = -1;
}
