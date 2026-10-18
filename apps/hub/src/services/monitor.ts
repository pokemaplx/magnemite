import type { deviceMetricsSchema, MonitorSpec } from "@magnemite/protocol";
import type { z } from "zod";
import {
  type DeviceKind,
  NOTIFY_CHANNELS,
  type MonitorAction,
  type NotifyChannel,
  type MonitorLevel,
  type MonitorSignal,
  parseNotifyChannels,
  type Prisma,
  prisma,
} from "@magnemite/db";
import { getHubSettings, getMonitorSettings } from "./hubSettings.js";
import { bus } from "../bus.js";
import { log } from "../log.js";
import { isOnline, sendTo } from "../registry.js";
import { execOnDevice } from "./deviceCommands.js";
import { ACTIVE_STATES } from "./jobs.js";
import { notify } from "./notify.js";
import { dockerAnswered, startDownInstances } from "./redroid.js";
import { deviceAction, rotomEnabled } from "./rotom.js";

/**
 * Monitoring: watch a box, and act when it stops working.
 *
 * The division of labour is the whole design. The box runs the probes, because
 * the evidence is a window of the scanner's own log and shipping that every
 * twenty seconds would cost more than the heartbeat. The hub keeps the
 * counters and decides, because escalation is a fleet-wide policy and because
 * a box that has locked up is in no position to decide to reboot itself.
 *
 * What this file is mostly made of is refusals. A watchdog that acts whenever
 * it is unsure is worse than none: the failure mode is a fleet that reboots
 * itself in a loop, and every guard below is one way that has been known to
 * happen.
 */

type DeviceMetrics = z.infer<typeof deviceMetricsSchema>;

// ---------------------------------------------------------------------------
// The latest reading
// ---------------------------------------------------------------------------

/**
 * What a box last said about itself, held in memory rather than written to a
 * row on every beat.
 *
 * This is deliberately *not* persisted. It is the answer to "how is this box
 * right now", it is replaced every heartbeat, and storing it would be a write
 * per box per beat for a value nothing reads afterwards. A hub restart empties
 * it, which reads as unknown for a few seconds until the next beat — and the
 * startup grace already covers that window.
 *
 * The ladders, which do have to survive a restart, live in `MonitorState`.
 */
type Reading = {
  at: number;
  /** False for an agent from before monitoring existed. See `monitorRan`. */
  ran: boolean;
  foreground: string;
  anr: Set<string>;
  checks: Map<string, { ok: boolean; detail: string | null }>;
  /** Packages with at least one live process, for the SERVICE_DOWN fallback. */
  processes: Set<string>;
};

const readings = new Map<string, Reading>();

/** Called from `applyMetrics` on every hello and heartbeat. */
export function recordReading(deviceId: string, metrics: DeviceMetrics): void {
  readings.set(deviceId, {
    at: Date.now(),
    ran: metrics.monitorRan === true,
    foreground: metrics.foregroundPackage ?? "",
    anr: new Set(metrics.anrPackages),
    checks: new Map(
      metrics.checks.map((check) => [check.id, { ok: check.ok, detail: check.detail ?? null }]),
    ),
    processes: new Set(
      metrics.processes.filter((p) => (p.processCount ?? 0) > 0).map((p) => p.packageName),
    ),
  });
}

export function forgetReading(deviceId: string): void {
  readings.delete(deviceId);
}

/**
 * A reading older than this is not evidence of anything.
 *
 * A box that went quiet keeps its last reading in the map, and acting on it
 * would mean force-stopping an app because of something seen ten minutes ago.
 */
const READING_MAX_AGE_MS = 3 * 60_000;

function freshReading(deviceId: string): Reading | null {
  const reading = readings.get(deviceId);
  if (!reading) return null;
  if (Date.now() - reading.at > READING_MAX_AGE_MS) return null;
  return reading;
}

// ---------------------------------------------------------------------------
// The action catalog
// ---------------------------------------------------------------------------

/**
 * The default command behind each action, `{pkg}` substituted.
 *
 * A catalog rather than a free-text field so that an alert can say "cleared
 * the cache and restarted" instead of quoting a command line — but every one
 * of them is editable per rule, because the app to poke and the way to poke it
 * differ between MITM setups.
 */
export const ACTION_COMMANDS: Partial<Record<MonitorAction, string>> = {
  RESTART_APP:
    "am force-stop {pkg}; sleep 2; monkey -p {pkg} -c android.intent.category.LAUNCHER 1",
  KILL_APP: "am force-stop {pkg}",
  CLEAR_CACHE_RESTART:
    "am force-stop {pkg}; rm -rf /data/data/{pkg}/cache; sleep 2; monkey -p {pkg} -c android.intent.category.LAUNCHER 1",
  // 66 is ENTER, which is what dismisses an ANR dialog.
  SEND_KEYEVENT: "input keyevent 66",
  // Was `am startservice {pkg}`, which could not work twice over: a package
  // name is not a service, so there was nothing for `am` to start, and even
  // spelled out as a component a plain `startservice` from the background is
  // refused on Android 8 and later with "app is in background uid null".
  //
  // A rule knows the package and not the service inside it, so launching the
  // app is the only thing that can be written generically — and it is what
  // starts the service in practice, because a scanner starts its own on
  // launch. `monkey` rather than `am start`, because it needs no component
  // either, and because it takes the app out of the stopped state a
  // `force-stop` leaves behind: Android delivers nothing to a stopped package.
  START_SERVICE: "monkey -p {pkg} -c android.intent.category.LAUNCHER 1",
  SHELL: "",
};

/** Actions that ride the device socket, and so need the box to be reachable. */
const NEEDS_SOCKET = new Set<MonitorAction>([
  "RESTART_APP",
  "KILL_APP",
  "CLEAR_CACHE_RESTART",
  "SEND_KEYEVENT",
  "START_SERVICE",
  "SHELL",
  "REBOOT",
  // The machine's own socket: docker is started by the agent on the machine,
  // so a machine that is not answering cannot have its containers started.
  "RESTART_INSTANCE",
]);

/**
 * Actions that cost a boot cycle, whichever socket carried them.
 *
 * `maxRebootsPerDeviceDay` and the reboot grace both key off this rather than
 * off `REBOOT` alone. Rotom reboots the same box through its own connection, so
 * a ceiling that only knew the agent-side spelling would be a ceiling a rule
 * could walk straight past by naming the other one.
 */
const HARD_ACTIONS = new Set<MonitorAction>([
  "REBOOT",
  "ROTOM_REBOOT",
  // The container *is* the box, so starting it is an Android cold boot and
  // every app on it comes back from nothing. The rule editor already tells an
  // operator this counts against the daily ceiling; this is the half that
  // makes that true.
  //
  // Counted against the *machine*, which is the device the action ran on, so
  // the ceiling bounds how often the monitor may cold-boot things on one
  // machine — and the post-action grace leaves that machine alone while the
  // Android inside comes up, for the same minutes a rebooted box gets.
  "RESTART_INSTANCE",
]);

function substitute(command: string, packageName: string | null): string {
  return command.replaceAll("{pkg}", packageName ?? "");
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

type RuleRow = Prisma.MonitorRuleGetPayload<{ include: { steps: true } }>;

/**
 * One rule's probe, as stored in its `config` JSON.
 *
 * Read defensively rather than with a schema: this is operator input that has
 * been round-tripped through a JSON column, and a rule with a malformed probe
 * should stop being evaluated, not stop the whole pass.
 */
type RuleProbe = Omit<MonitorSpec["checks"][number], "id">;

/**
 * Which channels this rule announces to.
 *
 * Read through `parseNotifyChannels`, which turns anything unreadable into
 * *every* channel rather than none — the same defensive reading `probeOf`
 * below does, pointed the other way. A malformed probe should stop being
 * evaluated; a malformed channel list should not stop being heard.
 */
function channelsOf(rule: RuleRow): NotifyChannel[] {
  return parseNotifyChannels(rule.notifyChannels);
}

function probeOf(rule: RuleRow): RuleProbe | null {
  const config = rule.config as { probe?: unknown } | null;
  const probe = config?.probe as Partial<RuleProbe> | undefined;
  if (!probe || typeof probe.target !== "string" || !probe.target) return null;
  if (probe.kind !== "shell" && probe.kind !== "http" && probe.kind !== "logMatch") return null;
  return {
    kind: probe.kind,
    target: probe.target,
    expect: probe.expect ?? null,
    lines: probe.lines ?? 200,
    failAt: probe.failAt ?? 1,
    successPattern: probe.successPattern ?? null,
    maxRatio: probe.maxRatio ?? null,
    maxAgeSeconds: probe.maxAgeSeconds ?? null,
    timeoutSeconds: probe.timeoutSeconds ?? 10,
  };
}

/**
 * A number out of the rule's `config`, or null.
 *
 * Read defensively for the reason `probeOf` is: this is operator input that
 * has been round-tripped through a JSON column. A floor that cannot be read is
 * *unknown*, which makes the signal silent rather than making it fire on every
 * machine at once.
 */
function numberOf(rule: RuleRow, key: string): number | null {
  const config = rule.config as Record<string, unknown> | null;
  const value = config?.[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

/**
 * Is `free` of `total` under the rule's percentage floor?
 *
 * Null wherever the answer would be a guess: a machine that has not reported
 * the pair yet, and a rule with no floor configured. Both are silence.
 */
function underFloor(rule: RuleRow, free: bigint | null, total: bigint | null): boolean | null {
  const percent = numberOf(rule, "minFreePercent");
  if (percent === null || free === null || total === null || total <= 0n) return null;
  return Number((free * 10000n) / total) / 100 < percent;
}

/**
 * Is `reading` over the rule's ceiling?
 *
 * The mirror of `underFloor` for the one reading that is an absolute rather
 * than a share: degrees are degrees, and 85 means the same thing on every box.
 *
 * Zero is treated as no reading at all, not as a cold box. `Temperatures()`
 * returns zero where the ROM exposes no sensor — common enough on TV hardware
 * to be a normal answer — and a floor of "under 85" would otherwise call every
 * sensorless box healthy forever. Unknown is the honest reading, and unknown
 * neither counts nor resets.
 */
function overCeiling(rule: RuleRow, reading: number | null, key: string): boolean | null {
  const ceiling = numberOf(rule, key);
  if (ceiling === null || reading === null || reading <= 0) return null;
  return reading > ceiling;
}

/** One machine's desired containers, tallied by what docker last said. */
export type HostInstances = { desired: number; running: number; unknown: number };

/**
 * Is a machine missing a container it is supposed to be running?
 *
 * Only the instances marked present count: a removed one keeps its row, and
 * counting it would have a drained machine alarm forever.
 *
 * Two silences, for the usual reason — unknown neither counts nor resets:
 *
 *  - **Nothing is supposed to run here.** A machine kept for capacity, or one
 *    that has not been scaled yet, is not broken.
 *  - **Nothing has been reported yet.** A row created moments ago by a
 *    scale-up has no state until the machine has been round the loop once, and
 *    a converge is what will create its container.
 *
 * Past those, the answer is about the instances actually known: all of them
 * running is healthy even while another is still unknown, so a machine
 * recovers on the one that came back rather than waiting for the one nothing
 * has looked at.
 */
export function instancesDown(counts: HostInstances): boolean | null {
  if (counts.desired === 0 || counts.desired === counts.unknown) return null;
  return counts.running < counts.desired - counts.unknown;
}

export async function loadEnabledRules(): Promise<RuleRow[]> {
  const settings = await getMonitorSettings();
  if (!settings.enabled) return [];
  return prisma.monitorRule.findMany({
    where: { enabled: true },
    include: { steps: { orderBy: { atFailure: "asc" } } },
    orderBy: { position: "asc" },
  });
}

/**
 * The rules that apply to one machine.
 *
 * A group-scoped rule *replaces* the fleet-wide rule for the same signal and
 * package rather than adding to it. Stacking them would mean two ladders
 * racing over one fault, and a box restarted twice for it.
 *
 * `kind` is the other half of that filter, and it is not optional: a box rule
 * evaluated against a VPS would read a scanner's absence as a fault on a
 * machine that never ran one, and a host rule against a box would do the
 * mirror image. Both would act.
 */
export function rulesFor(rules: RuleRow[], groupId: string | null, kind: DeviceKind): RuleRow[] {
  const chosen = new Map<string, RuleRow>();
  for (const rule of rules) {
    if (rule.appliesTo !== kind) continue;
    if (rule.groupId !== null && rule.groupId !== groupId) continue;
    const key = `${rule.signal}:${rule.packageName ?? ""}`;
    const winner = chosen.get(key);
    // Specific beats general; otherwise the first one wins, which `position`
    // already ordered.
    if (!winner || (winner.groupId === null && rule.groupId !== null)) chosen.set(key, rule);
  }
  return [...chosen.values()];
}

/** What to tell a box to watch, given the rules that apply to it. */
export function specFor(
  rules: RuleRow[],
  groupId: string | null,
  kind: DeviceKind = "BOX",
): MonitorSpec | null {
  const applicable = rulesFor(rules, groupId, kind);
  if (applicable.length === 0) return null;

  const spec: MonitorSpec = { foreground: false, anr: false, checks: [] };
  for (const rule of applicable) {
    if (rule.signal === "APP_NOT_FOREGROUND") spec.foreground = true;
    if (rule.signal === "APP_ANR") spec.anr = true;

    const probe = probeOf(rule);
    // The check's id is the rule's, so a result comes back already attributed.
    if (probe) spec.checks.push({ id: rule.id, ...probe });
  }

  if (!spec.foreground && !spec.anr && spec.checks.length === 0) return null;
  return spec;
}

/** The spec for one machine, for the `welcome` that accepts its socket. */
export async function specForDevice(
  groupId: string | null,
  kind: DeviceKind = "BOX",
): Promise<MonitorSpec | null> {
  return specFor(await loadEnabledRules(), groupId, kind);
}

// ---------------------------------------------------------------------------
// Reading the signals
// ---------------------------------------------------------------------------

type DeviceRow = Prisma.DeviceGetPayload<{ include: { group: { select: { name: true } } } }>;

/**
 * Is this signal bad right now?
 *
 * Three answers, and the third is the important one: `null` means *unknown*,
 * and unknown never counts as a failure. An agent too old to look, a probe
 * that ran out of budget, a Rotom that has never seen the box — all of them
 * are silence, and silence is not evidence.
 */
function readSignal(
  rule: RuleRow,
  device: DeviceRow,
  reading: Reading | null,
  /** Tallied once per pass, and empty for a fleet with no machines. */
  hosts: Map<string, HostInstances>,
  offlineAfterMs: number,
  rotomStaleMs: number,
  heartbeatMs: number,
): boolean | null {
  switch (rule.signal) {
    case "AGENT_OFFLINE": {
      // The registry before the row. A row is a record of the last write; the
      // socket is the fact. Asking the row first is how a box whose socket had
      // already come back stayed "unreachable" for a whole pass — and, with a
      // sweep that could not tell a mute box from a gone one, how a box that
      // never disconnected at all got announced as unreachable.
      if (isOnline(device.id)) return false;
      // No socket, and the row has not caught up. Nothing is known either way
      // yet: establishing it is the sweep's job, and it runs on its own clock.
      if (device.status === "ONLINE") return null;
      if (!device.lastSeenAt) return null;
      const gone = Date.now() - device.lastSeenAt.getTime();
      // The same timeout that decided the box is offline, rather than a second
      // delay of its own. Two numbers for one silence only ever differed by
      // how patient the alert was, and that is what a rule's `threshold`
      // already says — in beats, per rule, and per group.
      //
      // Below it nothing is known yet: a box is allowed to be away for a
      // moment without that being either a fault or a recovery.
      return gone >= offlineAfterMs ? true : null;
    }

    case "AGENT_STALLED": {
      // Only knowable while we hold the socket. A box that is simply gone is
      // AGENT_OFFLINE's fault, not this one — two ladders over one silence is
      // what `rulesFor` exists to prevent, and it would be one box told off
      // twice for the same quiet.
      //
      // The distinction earns its own signal because the remediation differs
      // completely: this box is reachable, so exec, RESTART_APP and REBOOT all
      // land on it. AGENT_OFFLINE can only ever tell you.
      if (!isOnline(device.id)) return null;
      if (!device.lastSeenAt) return null;
      const late = Date.now() - device.lastSeenAt.getTime();
      if (late >= offlineAfterMs) return true;
      // Inside two beats it is plainly reporting. Between that and the timeout
      // nothing is known: a beat is allowed to be late without that being
      // either a fault or a recovery, which is the shape AGENT_OFFLINE has
      // above, for the same reason.
      return late <= heartbeatMs * 2 ? false : null;
    }

    case "ROTOM_DISCONNECTED": {
      if (!rotomEnabled() || !device.rotomDeviceId) return null;
      // A box somebody disabled in Rotom is out of the pool on purpose.
      // Alerting on that means alerting on a decision already made — and it is
      // now the only way a box gets disabled, since Magnemite no longer does it
      // around installs.
      if (!device.rotomEnabled) return null;

      if (!device.rotomConnected || !device.rotomCanBeUsed) return true;
      if (device.rotomLastSeenAt) {
        return Date.now() - device.rotomLastSeenAt.getTime() >= rotomStaleMs;
      }
      return false;
    }

    case "ROTOM_NOT_SCANNING": {
      if (!rotomEnabled() || !device.rotomDeviceId) return null;
      if (!device.rotomEnabled) return null;
      // A box Rotom has lost is ROTOM_DISCONNECTED's fault, not this one. Two
      // ladders over one fault is exactly what `rulesFor` exists to prevent,
      // and it would be the same box rebooted twice.
      if (!device.rotomConnected) return null;
      // Rotom did not say how many workers it has. Old build, or a shape this
      // hub could not read — either way, not evidence of anything.
      if (device.rotomWorkerCount === null) return null;
      // No MITM attached at all: the scanner is up and never registered.
      if (device.rotomWorkerCount === 0) return true;
      if (device.rotomWorkersInUse === null) return null;
      return device.rotomWorkersInUse === 0;
    }

    case "ROTOM_IDLE": {
      if (!rotomEnabled() || !device.rotomDeviceId) return null;
      if (!device.rotomEnabled || !device.rotomConnected) return null;
      // Nothing allocated is ROTOM_NOT_SCANNING's fault, not this one.
      if (!device.rotomWorkersInUse) return null;
      // No worker reported a rate. Rotom only measures them in `requests` mode,
      // or `proxy` with `inspect`; on any other mode this signal is silent by
      // design rather than reading every box as idle.
      if (!device.rotomStatWorkers || device.rotomRequestRate === null) return null;
      // Zero requests across five minutes on a worker Rotom is holding open.
      // Not a threshold anyone has to tune: a box doing any work is above it.
      return device.rotomRequestRate <= 0;
    }

    case "SERVICE_DOWN": {
      const probe = probeOf(rule);
      if (probe) return checkResult(rule, reading);
      // No probe configured: fall back to whether the package has a process.
      if (!reading || !rule.packageName) return null;
      // An entirely empty process list is ambiguous — it is what an agent too
      // old to report them sends, and also what a box with everything dead
      // sends. The safe reading of that is unknown; a fleet that wants
      // certainty configures the probe, which is what the seeded rule does.
      if (reading.processes.size === 0) return null;
      return !reading.processes.has(rule.packageName);
    }

    case "APP_NOT_FOREGROUND": {
      if (!reading?.ran || !rule.packageName) return null;
      // An empty foreground is the launcher sitting on the screen, which is
      // exactly the fault. `ran` is what makes that readable rather than
      // indistinguishable from an agent that never looked.
      return reading.foreground !== rule.packageName;
    }

    case "APP_ANR": {
      if (!reading?.ran || !rule.packageName) return null;
      return reading.anr.has(rule.packageName);
    }

    case "HEALTH_CHECK_FAILED":
    case "LOOP_STALLED":
      return checkResult(rule, reading);

    // --- the box's own resources -------------------------------------------
    // Read straight off the columns, like the host three below and for the same
    // reason: the agent reports all of this on every heartbeat already, the
    // Load card draws it, and nothing here needs a probe, a protocol message
    // or an agent new enough to have heard of monitoring.

    case "DEVICE_MEMORY_LOW":
      // No swap in the sum, unlike the machine's: a box has none, and adding
      // `?? 0n` would turn a reading the kernel does not have into a zero that
      // reads as "no headroom".
      //
      // Honest inside a container, because `sys.Memory` reads the cgroup
      // rather than /proc/meminfo. The exception is a container with no memory
      // limit at all, which falls back to the machine's figure and will never
      // trip this -- the rule dialog says so, because a rule that cannot fire
      // is worse than no rule.
      return underFloor(rule, device.memAvailableBytes, device.memTotalBytes);

    case "DEVICE_STORAGE_LOW":
      // `/data`, which is the partition an install writes to -- so this is the
      // signal that gets ahead of a failure rather than reporting one. An
      // install refuses on low space and the job fails; a rule that clears
      // caches at 10% turns that into nothing happening at all.
      return underFloor(rule, device.freeBytes, device.totalBytes);

    case "DEVICE_TEMP_HIGH":
      // The SoC, not the battery: a TV box has no battery, and the boxes that
      // report one are reporting a cell nothing is drawing from.
      return overCeiling(rule, device.cpuTempC, "maxTempC");

    // --- hosts -------------------------------------------------------------
    // These read the machine's own columns rather than a probe result, because
    // a host reports them on every heartbeat like any other box. What makes
    // them host signals is `appliesTo`, which `rulesFor` has already filtered
    // on by the time we get here.

    case "HOST_MEMORY_LOW": {
      // Swap counts as headroom, because on these machines it is exactly what
      // stands between fifty workers and the OOM killer. A machine with no
      // swap at all reports zero rather than null -- see the pointer fields in
      // the protocol -- so adding it is safe and a missing reading stays
      // unknown.
      const free =
        device.memAvailableBytes === null
          ? null
          : device.memAvailableBytes + (device.swapFreeBytes ?? 0n);
      const total =
        device.memTotalBytes === null ? null : device.memTotalBytes + (device.swapTotalBytes ?? 0n);
      return underFloor(rule, free, total);
    }

    case "HOST_DISK_LOW":
      // The filesystem docker keeps its images and volumes on, which is what
      // the host agent reports as its free/total pair. A full disk fails
      // installs rather than announcing itself.
      return underFloor(rule, device.freeBytes, device.totalBytes);

    case "HOST_DOCKER_DOWN": {
      // The agent is up — it is reporting — and docker did not answer it. That
      // is a different fault from the machine going silent, which is what
      // AGENT_OFFLINE is for, and it is separately actionable: the containers
      // are gone and nothing on the machine is going to bring them back.
      //
      // Held in memory, so a hub that just restarted says unknown for one
      // heartbeat. The startup grace already covers that window.
      const answered = dockerAnswered(device.id);
      return answered === null ? null : !answered;
    }

    case "REDROID_INSTANCE_DOWN":
      // Tallied once for the whole pass rather than queried per rule. A
      // machine with no entry is one with no instance rows at all.
      return instancesDown(hosts.get(device.id) ?? { desired: 0, running: 0, unknown: 0 });
  }
}

function checkResult(rule: RuleRow, reading: Reading | null): boolean | null {
  if (!reading?.ran) return null;
  const result = reading.checks.get(rule.id);
  // No result means the probe did not run — it was added since the box's last
  // welcome, or the beat ran out of budget. Not a failure.
  if (!result) return null;
  return !result.ok;
}

function detailFor(rule: RuleRow, reading: Reading | null): string | null {
  return reading?.checks.get(rule.id)?.detail ?? null;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

let lastTickAt = 0;
let startedAt = Date.now();
let lastPruneAt = 0;

/**
 * Restart the startup grace.
 *
 * Called on boot. The hub runs under `tsx watch` in development, so every file
 * save restarts it and drops every device socket at once — without this,
 * editing this repository would reboot the fleet.
 */
export function markMonitorStart(): void {
  startedAt = Date.now();
  readings.clear();
}

/** "HH:MM" window, inclusive of the start, exclusive of the end. Wraps midnight. */
function insideWindow(start: string | null, end: string | null, now = new Date()): boolean {
  if (!start || !end) return true;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const toMinutes = (v: string) => {
    const [h = "0", m = "0"] = v.split(":");
    return Number(h) * 60 + Number(m);
  };
  const from = toMinutes(start);
  const to = toMinutes(end);
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/**
 * One evaluation pass, keeping its own clock so it can ride the scheduler's
 * five-second tick without running twelve times a minute.
 *
 * That clock is the heartbeat, and deliberately not a setting of its own. A
 * pass reads what the boxes last said, and they say it once per beat: running
 * more often re-reads the same reading and counts one fault twice, running
 * less often just adds lag. There is exactly one right answer, so there is
 * nothing to configure.
 */
export async function evaluate(): Promise<void> {
  const settings = await getMonitorSettings();
  if (!settings.enabled) return;

  const { heartbeatSeconds, deviceOfflineTimeoutSeconds } = await getHubSettings();
  const now = Date.now();
  if (now - startedAt < settings.startupGraceSeconds * 1000) return;
  if (now - lastTickAt < heartbeatSeconds * 1000) return;
  lastTickAt = now;

  const rules = await loadEnabledRules();
  if (rules.length === 0) return;

  const devices = await prisma.device.findMany({
    where: { approved: true },
    include: { group: { select: { name: true } } },
  });
  if (devices.length === 0) return;

  const busy = await busyDeviceIds(settings.rebootGraceSeconds);
  const budgets = await spentBudgets();
  const hosts = await hostInstances(devices);

  for (const device of devices) {
    if (busy.has(device.id)) continue;
    try {
      await evaluateDevice(
        device,
        rules,
        settings,
        deviceOfflineTimeoutSeconds * 1000,
        heartbeatSeconds * 1000,
        budgets,
        hosts,
      );
    } catch (err) {
      // One box's failure is not the fleet's. A rule with a broken command
      // must not stop every other box being looked at.
      log.error({ err, device: device.name }, "monitor pass failed for a device");
    }
  }

  await pruneEvents(settings.eventRetentionDays);
}

/**
 * What every machine's instances are doing, in one query for the whole pass.
 *
 * One query rather than one per machine per rule, and skipped entirely for a
 * fleet with no machines in it — which is every fleet until somebody adds one.
 */
async function hostInstances(devices: DeviceRow[]): Promise<Map<string, HostInstances>> {
  const hostIds = devices.filter((device) => device.kind === "HOST").map((device) => device.id);
  if (hostIds.length === 0) return new Map();

  const rows = await prisma.redroidInstance.findMany({
    where: { hostId: { in: hostIds }, present: true },
    select: { hostId: true, containerState: true },
  });

  const counts = new Map<string, HostInstances>();
  for (const row of rows) {
    const tally = counts.get(row.hostId) ?? { desired: 0, running: 0, unknown: 0 };
    tally.desired += 1;
    if (row.containerState === null) tally.unknown += 1;
    else if (row.containerState === "running") tally.running += 1;
    counts.set(row.hostId, tally);
  }
  return counts;
}

/**
 * Boxes and machines that must be left alone this pass.
 *
 * Four reasons, all of which look like a fault and are not:
 *
 *  - **An install is running.** It force-stops the scanner on purpose, so every
 *    probe would faithfully report the damage the hub itself asked for.
 *  - **Somebody is working on it.** A box in maintenance has had its scanner
 *    stopped by the hook that put it there, which is the install case with a
 *    person holding the box instead of the hub.
 *  - **We just rebooted it.** A box takes minutes to come back. Without this
 *    its own reboot reads as unreachable and it is rebooted again, forever.
 *  - **A machine is converging.** Its containers are being created, recreated
 *    or destroyed right now, because somebody asked for that — so instances
 *    legitimately are not running, and a container being rebuilt is not a
 *    container that failed. The install case for a machine, in other words.
 */
async function busyDeviceIds(rebootGraceSeconds: number): Promise<Set<string>> {
  const [installing, rebooted, converging, parked] = await Promise.all([
    prisma.job.findMany({
      where: { state: { in: ACTIVE_STATES } },
      select: { deviceId: true },
    }),
    prisma.monitorEvent.findMany({
      where: {
        action: { in: [...HARD_ACTIONS] },
        actionOk: true,
        at: { gte: new Date(Date.now() - rebootGraceSeconds * 1000) },
      },
      select: { deviceId: true },
    }),
    prisma.redroidHost.findMany({
      where: { convergingSince: { not: null } },
      select: { deviceId: true },
    }),
    // **Somebody is working on it.** The install case with a person in it: the
    // scanner is stopped on purpose, by the hook entering maintenance ran, and
    // the only thing a rule could report is the damage an operator asked for.
    //
    // `gt` rather than `not: null`, so a window that has run out stops
    // protecting the box on the same tick the sweep closes it.
    prisma.device.findMany({
      where: { maintenanceUntil: { gt: new Date() } },
      select: { id: true },
    }),
  ]);
  return new Set([
    ...installing.map((row) => row.deviceId),
    ...rebooted.map((row) => row.deviceId),
    ...converging.map((row) => row.deviceId),
    ...parked.map((row) => row.id),
  ]);
}

type Budgets = { actions: Map<string, number>; reboots: Map<string, number> };

/** What each box has already had spent on it, for the circuit breakers. */
async function spentBudgets(): Promise<Budgets> {
  const now = Date.now();
  const [actions, reboots] = await Promise.all([
    prisma.monitorEvent.groupBy({
      by: ["deviceId"],
      where: { action: { not: null }, at: { gte: new Date(now - 3_600_000) } },
      _count: { _all: true },
    }),
    prisma.monitorEvent.groupBy({
      by: ["deviceId"],
      where: { action: { in: [...HARD_ACTIONS] }, at: { gte: new Date(now - 86_400_000) } },
      _count: { _all: true },
    }),
  ]);
  return {
    actions: new Map(actions.map((row) => [row.deviceId, row._count._all])),
    reboots: new Map(reboots.map((row) => [row.deviceId, row._count._all])),
  };
}

type Settings = Awaited<ReturnType<typeof getMonitorSettings>>;

async function evaluateDevice(
  device: DeviceRow,
  rules: RuleRow[],
  settings: Settings,
  offlineAfterMs: number,
  heartbeatMs: number,
  budgets: Budgets,
  hosts: Map<string, HostInstances>,
): Promise<void> {
  const reading = freshReading(device.id);

  for (const rule of rulesFor(rules, device.groupId, device.kind)) {
    const bad = readSignal(
      rule,
      device,
      reading,
      hosts,
      offlineAfterMs,
      settings.rotomStaleSeconds * 1000,
      heartbeatMs,
    );
    if (bad === null) continue;

    const state = await prisma.monitorState.findUnique({
      where: { deviceId_ruleId: { deviceId: device.id, ruleId: rule.id } },
    });

    if (!bad) {
      await recover(device, rule, state);
      continue;
    }

    const failures = (state?.failures ?? 0) + 1;
    await prisma.monitorState.upsert({
      where: { deviceId_ruleId: { deviceId: device.id, ruleId: rule.id } },
      update: { failures, firstFailedAt: state?.firstFailedAt ?? new Date() },
      create: { deviceId: device.id, ruleId: rule.id, failures, firstFailedAt: new Date() },
    });

    if (failures < rule.threshold) continue;
    await escalate(device, rule, { ...state, failures }, settings, budgets, reading);
  }
}

/** The signal went good again. Reset the ladder, and say so if it had moved. */
async function recover(
  device: DeviceRow,
  rule: RuleRow,
  state: { failures: number } | null,
): Promise<void> {
  if (!state || state.failures === 0) return;

  await prisma.monitorState.update({
    where: { deviceId_ruleId: { deviceId: device.id, ruleId: rule.id } },
    data: { failures: 0, firstFailedAt: null, lastStepFired: null },
  });
  // The row is always written — the recovery is half of what the activity
  // feed is for. Whether it also goes anywhere is opted into per rule, and
  // then only for an episode that reached the threshold: an all-clear for a
  // fault nobody was told about is noise on its own. It goes to the same
  // channels the fault did, which is the only answer that makes sense — a
  // recovery announced somewhere the fault was not is a message about
  // nothing.
  //
  // And "nobody was told" has a second cause that the threshold cannot see.
  // `recover` clears the ladder but leaves `lastActionAt`, so the *next*
  // episode reaches `escalate` and dies at the cooldown — no action, no row,
  // no message. Its recovery then passed every test here and announced
  // itself: a lone "recovered" in Discord for a fault nobody had been told
  // about, with nothing in the feed to explain it. So the last word on this
  // rule has to have actually gone out.
  const fault = await prisma.monitorEvent.findFirst({
    where: { deviceId: device.id, ruleId: rule.id, recovery: false },
    orderBy: { at: "desc" },
    select: { notified: true },
  });
  const announce =
    rule.notifyRecovery && state.failures >= rule.threshold && fault?.notified === true
      ? channelsOf(rule)
      : [];
  await record(
    device,
    rule,
    {
      level: "INFO",
      message: `${rule.name} recovered`,
      action: null,
      actionOk: null,
      detail: null,
      recovery: true,
    },
    announce,
  );
}

async function escalate(
  device: DeviceRow,
  rule: RuleRow,
  state: { failures: number; lastActionAt?: Date | null; lastStepFired?: number | null },
  settings: Settings,
  budgets: Budgets,
  reading: Reading | null,
): Promise<void> {
  // The rung this many failures has earned: the highest one at or below the
  // count, so a box that failed three times in a row does not walk back up
  // through the gentle steps it has already proved do not work.
  const ladder = [...rule.steps].sort((a, b) => b.atFailure - a.atFailure);
  const step = ladder.find((s) => s.atFailure <= state.failures);
  if (!step) return;

  // Cooldown first: it is what keeps a fault that never clears from being
  // acted on every single pass.
  if (state.lastActionAt) {
    const since = Date.now() - state.lastActionAt.getTime();
    if (since < rule.cooldownSeconds * 1000) return;
  }

  // A rung already spent is not spent again — a box that has proved a restart
  // does not fix it should not keep being restarted. The exception is the top
  // of the ladder, which repeats at the cooldown for as long as the fault
  // lasts: there is nothing stronger left to try, and the circuit breakers are
  // what stop that rather than a one-shot flag.
  const isTop = ladder[0] !== undefined && step.atFailure === ladder[0].atFailure;
  const spent = state.lastStepFired ?? null;
  if (spent !== null && step.atFailure <= spent && !isTop) return;

  // Quiet hours stop the *action*, never the alert. Not rebooting a box at 3am
  // is a reasonable policy; hiding that it needs one is not.
  const acting = insideWindow(rule.windowStart, rule.windowEnd) && step.action !== "NOTIFY_ONLY";

  const detail = detailFor(rule, reading);
  if (!acting) {
    // The rung is deliberately *not* marked spent: an action held back by
    // quiet hours has to still run once the window opens, rather than the
    // ladder having quietly skipped it overnight.
    await fire(device, rule, null, {
      level: rule.notifyLevel,
      message: rule.name,
      action: step.action === "NOTIFY_ONLY" ? null : step.action,
      actionOk: null,
      detail:
        step.action === "NOTIFY_ONLY"
          ? detail
          : [`held back until ${rule.windowStart}`, detail].filter(Boolean).join(" · "),
    });
    return;
  }

  if (NEEDS_SOCKET.has(step.action) && !isOnline(device.id)) {
    // Refused rather than failed: the step is not spent, so it still runs when
    // the box comes back rather than the ladder having burned a rung on a
    // message that went nowhere.
    log.debug({ device: device.name, action: step.action }, "monitor action needs the box online");
    return;
  }

  const breaker = tripped(device, step.action, settings, budgets);
  if (breaker) {
    // Same reasoning as the window: the rung is not spent, so the ladder
    // resumes where it was once the hour or the day rolls.
    await fire(device, rule, null, {
      level: "CRITICAL",
      message: `${rule.name} — stopped acting on this box`,
      action: null,
      actionOk: null,
      detail: breaker,
    });
    return;
  }

  const outcome = await runAction(device, rule, step.action, step.command);
  spend(device.id, step.action, budgets);

  await fire(device, rule, step.atFailure, {
    level: outcome.ok ? rule.notifyLevel : "CRITICAL",
    message: rule.name,
    action: step.action,
    actionOk: outcome.ok,
    detail: [detail, outcome.detail].filter(Boolean).join(" · ") || null,
  });
}

/**
 * The circuit breakers, and the reason this feature is safe to leave running.
 *
 * A rule that is simply wrong — a probe pointed at the wrong log, a regex that
 * matches every line — otherwise acts forever. Past either ceiling the box is
 * announced once and then left alone until the window rolls.
 */
function tripped(
  device: DeviceRow,
  action: MonitorAction,
  settings: Settings,
  budgets: Budgets,
): string | null {
  const actions = budgets.actions.get(device.id) ?? 0;
  if (actions >= settings.maxActionsPerDeviceHour) {
    return `${actions} actions in the last hour, at a ceiling of ${settings.maxActionsPerDeviceHour}`;
  }
  if (HARD_ACTIONS.has(action)) {
    const reboots = budgets.reboots.get(device.id) ?? 0;
    if (reboots >= settings.maxRebootsPerDeviceDay) {
      return `${reboots} reboots today, at a ceiling of ${settings.maxRebootsPerDeviceDay}`;
    }
  }
  return null;
}

function spend(deviceId: string, action: MonitorAction, budgets: Budgets): void {
  budgets.actions.set(deviceId, (budgets.actions.get(deviceId) ?? 0) + 1);
  if (HARD_ACTIONS.has(action)) {
    budgets.reboots.set(deviceId, (budgets.reboots.get(deviceId) ?? 0) + 1);
  }
}

async function runAction(
  device: DeviceRow,
  rule: RuleRow,
  action: MonitorAction,
  command: string | null,
): Promise<{ ok: boolean; detail: string | null }> {
  if (action === "NOTIFY_ONLY") return { ok: true, detail: null };

  if (action === "REBOOT") {
    const sent = sendTo(device.id, { type: "reboot" });
    return { ok: sent, detail: sent ? null : "the box did not take the reboot" };
  }

  // One machine's containers, by name, and nothing else on it. Deliberately
  // not reachable on a box: a box has no containers, and the form refuses the
  // action on a BOX rule for the same reason.
  if (action === "RESTART_INSTANCE") {
    if (device.kind !== "HOST") return { ok: false, detail: "not a machine" };
    return await startDownInstances(device.id);
  }

  // The three that travel Rotom's own socket rather than the agent's, which is
  // what makes them the only remediation left on a box whose agent has died.
  // They fail on a box Rotom has lost, for the mirrored reason.
  if (action === "ROTOM_RESTART" || action === "ROTOM_DISCONNECT" || action === "ROTOM_REBOOT") {
    if (!device.rotomDeviceId) return { ok: false, detail: "not matched in rotom" };
    const verb = {
      ROTOM_RESTART: "restart",
      ROTOM_DISCONNECT: "disconnect",
      ROTOM_REBOOT: "reboot",
    }[action] as "restart" | "disconnect" | "reboot";
    const ok = await deviceAction(device.rotomDeviceId, verb);
    return { ok, detail: ok ? null : `rotom refused the ${verb}` };
  }

  const script = substitute(command ?? ACTION_COMMANDS[action] ?? "", rule.packageName);
  if (!script.trim()) return { ok: false, detail: "the rule has no command to run" };

  const outcome = await execOnDevice(device.id, script, 60).catch((err: unknown) => ({
    ok: false,
    output: "",
    error: err instanceof Error ? err.message : String(err),
  }));
  return {
    ok: outcome.ok,
    // Command output only when it failed; a successful force-stop prints
    // nothing worth putting in an alert.
    detail: outcome.ok ? null : (outcome.error ?? outcome.output.slice(0, 400) ?? null),
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

type EventInput = {
  level: MonitorLevel;
  message: string;
  action: MonitorAction | null;
  actionOk: boolean | null;
  detail: string | null;
  /** The all-clear rather than a fault. Only `recover` writes one. */
  recovery?: boolean;
};

/**
 * Has this exact announcement already been made, with nothing since?
 *
 * Only asked of the events that announce a *state* rather than an action — a
 * tripped breaker, an action held back by quiet hours. Those recur on every
 * cooldown for as long as the state lasts, and without this a rule that is
 * simply wrong writes a row per box per cooldown until somebody notices. An
 * action never takes this path: three reboots are three things that happened,
 * and collapsing them would hide the very thing the table is for.
 */
async function alreadySaid(deviceId: string, ruleId: string, message: string): Promise<boolean> {
  const latest = await prisma.monitorEvent.findFirst({
    where: { deviceId, ruleId },
    orderBy: { at: "desc" },
    select: { message: true, action: true },
  });
  return latest !== null && latest.action === null && latest.message === message;
}

/**
 * Stamp the ladder and write the event in one place, so they cannot diverge.
 *
 * `atFailure` is null for an event that announced something without acting on
 * it — held back by quiet hours, or refused by a circuit breaker. Those still
 * take the cooldown, so the same thing is not announced every pass, but they
 * must not mark the rung spent: the action is deferred, not skipped.
 */
async function fire(
  device: DeviceRow,
  rule: RuleRow,
  atFailure: number | null,
  event: EventInput,
): Promise<void> {
  await prisma.monitorState.update({
    where: { deviceId_ruleId: { deviceId: device.id, ruleId: rule.id } },
    data: {
      lastActionAt: new Date(),
      ...(atFailure === null ? {} : { lastStepFired: atFailure }),
    },
  });

  // Still stamped above, so the cooldown keeps holding — but a state that has
  // not changed is not news twice. A box parked behind a tripped breaker would
  // otherwise write a row every cooldown for as long as the fault lasts.
  if (atFailure === null && (await alreadySaid(device.id, rule.id, event.message))) return;

  await record(device, rule, event);
}

/**
 * `announce` is which channels hear about this. It defaults to the rule's own
 * list, which is the answer for every fault; `recover` passes its own because
 * the all-clear is a separate opt-in and an empty list is how it declines.
 */
async function record(
  device: DeviceRow,
  rule: RuleRow,
  event: EventInput,
  announce: NotifyChannel[] = channelsOf(rule),
): Promise<void> {
  const recovery = event.recovery ?? false;
  const notified =
    announce.length > 0
      ? await notify({
          deviceId: device.id,
          channels: announce,
          deviceName: device.name,
          groupName: device.group?.name ?? null,
          signal: rule.signal,
          level: event.level,
          message: event.message,
          action: event.action,
          actionOk: event.actionOk,
          detail: event.detail,
          recovery,
        }).catch(() => false)
      : false;

  await prisma.monitorEvent.create({
    data: {
      deviceId: device.id,
      ruleId: rule.id,
      signal: rule.signal,
      level: event.level,
      message: event.message,
      action: event.action,
      actionOk: event.actionOk,
      detail: event.detail,
      // Only true when the message actually landed, so a quiet hour is
      // explicable from the table rather than a mystery.
      notified,
      recovery,
    },
  });

  log.info(
    { device: device.name, rule: rule.name, action: event.action, ok: event.actionOk },
    event.message,
  );
  // A monitor event is a change to a device, so it rides the event the
  // dashboard already listens for rather than needing one of its own.
  bus.publish({ kind: "device", deviceId: device.id });
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

const POGO = "com.nianticlabs.pokemongo";
const SCANNER = "com.pokemod.aegis";
/** Where Atlas writes. A fleet on another MITM edits this in the rule. */
const MITM_LOG = "/data/local/tmp/atlas.log";

type Seed = {
  name: string;
  signal: MonitorSignal;
  /** Omitted is BOX, which is the column's default and what most seeds are. */
  appliesTo?: DeviceKind;
  packageName: string | null;
  config: Prisma.InputJsonValue;
  threshold: number;
  cooldownSeconds: number;
  /** Which channels the seed announces to. Empty is "act, say nothing". */
  notifyChannels: NotifyChannel[];
  notifyLevel: MonitorLevel;
  steps: { atFailure: number; action: MonitorAction }[];
};

/**
 * The rules a new fleet starts with, all **disabled**.
 *
 * Their thresholds and ladders are not invented: they are what aconf's
 * `atlas_monitor.sh` has been doing on this hardware for years, where
 * `atlasdead` and `pogodead` count to one for a soft restart and to two for a
 * reboot. The probe strings are Atlas's, which is why they are rows — a fleet
 * on Aegis, Cosmog or GC edits them, and that is the whole point.
 *
 * Disabled because upgrading a fleet must never start rebooting it. Somebody
 * has to read these and turn them on.
 */
const SEEDS: Seed[] = [
  {
    name: "Scanner offline",
    signal: "SERVICE_DOWN",
    packageName: SCANNER,
    config: {
      probe: {
        kind: "shell",
        target: "dumpsys activity services | grep -e MappingService",
        timeoutSeconds: 15,
      },
    },
    threshold: 1,
    cooldownSeconds: 300,
    notifyChannels: [...NOTIFY_CHANNELS],
    notifyLevel: "WARN",
    steps: [
      { atFailure: 1, action: "RESTART_APP" },
      { atFailure: 2, action: "REBOOT" },
    ],
  },
  {
    name: "Pogo not in focus",
    signal: "APP_NOT_FOREGROUND",
    packageName: POGO,
    config: {},
    threshold: 1,
    cooldownSeconds: 300,
    // aconf defaults this one's webhook to off, and it is right to: a box
    // briefly on the launcher is common enough that announcing every one
    // teaches people to mute the channel.
    notifyChannels: [],
    notifyLevel: "INFO",
    steps: [
      { atFailure: 1, action: "CLEAR_CACHE_RESTART" },
      { atFailure: 2, action: "REBOOT" },
    ],
  },
  {
    name: "Pogo not responding",
    signal: "APP_ANR",
    packageName: POGO,
    config: {},
    threshold: 1,
    cooldownSeconds: 120,
    notifyChannels: [...NOTIFY_CHANNELS],
    notifyLevel: "WARN",
    steps: [
      // ENTER dismisses the dialog, which is usually the whole fix.
      { atFailure: 1, action: "SEND_KEYEVENT" },
      { atFailure: 2, action: "REBOOT" },
    ],
  },
  {
    name: "Health check failing",
    signal: "HEALTH_CHECK_FAILED",
    packageName: POGO,
    config: {
      probe: {
        kind: "logMatch",
        target: MITM_LOG,
        lines: 200,
        // Ten of these only matter when they outnumber the work getting done,
        // which is why the success pattern is half the rule.
        expect: "\\[HEALTH CHECK\\] ([0-9]+) seconds since last ping\\.",
        failAt: 10,
        successPattern: "I \\| Worker",
        maxRatio: 1,
        timeoutSeconds: 15,
      },
    },
    threshold: 1,
    cooldownSeconds: 600,
    notifyChannels: [...NOTIFY_CHANNELS],
    notifyLevel: "WARN",
    steps: [{ atFailure: 1, action: "KILL_APP" }],
  },
  {
    name: "Loop stalled",
    signal: "LOOP_STALLED",
    packageName: SCANNER,
    config: {
      probe: {
        kind: "logMatch",
        target: MITM_LOG,
        lines: 200,
        expect: "loop has been stalled for over a minute",
        failAt: 1,
        timeoutSeconds: 15,
      },
    },
    threshold: 1,
    cooldownSeconds: 600,
    notifyChannels: [...NOTIFY_CHANNELS],
    notifyLevel: "WARN",
    steps: [{ atFailure: 1, action: "RESTART_APP" }],
  },
  {
    name: "Box connected but silent",
    signal: "AGENT_STALLED",
    packageName: null,
    config: {},
    // Two beats of grace on top of the timeout, because the whole point of
    // this signal is that the box is still there: there is no urgency a
    // disconnection would carry, and a slow beat should not be an alert.
    threshold: 2,
    cooldownSeconds: 600,
    notifyChannels: [...NOTIFY_CHANNELS],
    notifyLevel: "WARN",
    // Unlike "Box unreachable", a ladder here could actually do something —
    // the socket is open. It still ships as notify-only, because what to do
    // about a wedged agent is a decision for whoever reads the first one.
    steps: [{ atFailure: 1, action: "NOTIFY_ONLY" }],
  },
  {
    name: "Box unreachable",
    signal: "AGENT_OFFLINE",
    packageName: null,
    config: {},
    threshold: 1,
    cooldownSeconds: 1800,
    notifyChannels: [...NOTIFY_CHANNELS],
    notifyLevel: "WARN",
    // Nothing else is possible: a box Magnemite cannot reach cannot be told
    // to do anything about it.
    steps: [{ atFailure: 1, action: "NOTIFY_ONLY" }],
  },
  {
    name: "Rotom lost the box",
    signal: "ROTOM_DISCONNECTED",
    packageName: null,
    config: {},
    threshold: 2,
    cooldownSeconds: 1800,
    notifyChannels: [...NOTIFY_CHANNELS],
    notifyLevel: "WARN",
    steps: [
      { atFailure: 1, action: "NOTIFY_ONLY" },
      { atFailure: 3, action: "ROTOM_RESTART" },
      // Rotom cannot reboot a box it has lost — there is no connection left to
      // send it down — so the bottom rung is the agent's own socket, which is
      // still there whenever the box is only invisible to Rotom.
      { atFailure: 6, action: "REBOOT" },
    ],
  },
  {
    name: "Rotom has the box but no workers",
    signal: "ROTOM_NOT_SCANNING",
    packageName: null,
    config: {},
    // A fleet with more boxes than accounts has idle spares on purpose, so this
    // one waits longer than the rest before it believes anything.
    threshold: 3,
    cooldownSeconds: 1800,
    notifyChannels: [...NOTIFY_CHANNELS],
    notifyLevel: "WARN",
    steps: [
      { atFailure: 1, action: "NOTIFY_ONLY" },
      { atFailure: 3, action: "ROTOM_RESTART" },
      { atFailure: 6, action: "ROTOM_REBOOT" },
    ],
  },
  {
    name: "Scanner is allocated and doing nothing",
    signal: "ROTOM_IDLE",
    packageName: null,
    config: {},
    // Rotom's own window is five minutes wide and the sync is a minute, so one
    // reading is not five minutes of evidence. Five of them is.
    threshold: 5,
    cooldownSeconds: 1800,
    notifyChannels: [...NOTIFY_CHANNELS],
    notifyLevel: "WARN",
    steps: [
      { atFailure: 1, action: "NOTIFY_ONLY" },
      // Disconnect before restart: a stuck worker allocation is exactly what it
      // clears, and it costs a reconnect rather than an app launch.
      { atFailure: 5, action: "ROTOM_DISCONNECT" },
      { atFailure: 8, action: "ROTOM_RESTART" },
    ],
  },

  // --- the box's own resources ----------------------------------------------
  // The three that need nothing from the box it is not already saying. Their
  // lineage is the two tools this fleet was run with before Magnemite:
  // magisk-furtif restarts the stack under 200 MB free, and Rotomina has a
  // per-device `memory_threshold` that does the same. A share rather than a
  // fixed number of megabytes, because 200 MB means something different on a
  // 2 GB TV box and an 8 GB container.

  {
    name: "Box is low on memory",
    signal: "DEVICE_MEMORY_LOW",
    // Pogo rather than the scanner: the game is what eats the memory, and
    // restarting it is the narrower of the two things that would free any.
    packageName: POGO,
    config: { minFreePercent: 15 },
    // Three readings, because a box that has just booted is a spike: Android
    // takes most of its memory in the first minute and hands some back.
    threshold: 3,
    cooldownSeconds: 1800,
    notifyChannels: [...NOTIFY_CHANNELS],
    notifyLevel: "WARN",
    steps: [
      { atFailure: 1, action: "CLEAR_CACHE_RESTART" },
      { atFailure: 2, action: "REBOOT" },
    ],
  },
  {
    name: "Box is low on disk",
    signal: "DEVICE_STORAGE_LOW",
    packageName: POGO,
    config: { minFreePercent: 10 },
    // A disk fills slowly, so two in a row is a trend rather than a spike.
    threshold: 2,
    cooldownSeconds: 3600,
    notifyChannels: [...NOTIFY_CHANNELS],
    notifyLevel: "WARN",
    // The first rung is the only action on the catalog that actually frees
    // space, and the point of this rule is to run it *before* a rollout
    // arrives and fails on the refusal. The second says so and stops: a box
    // whose /data is full of something other than a cache is not a thing more
    // force-stops will fix, and the last rung repeats at the cooldown.
    steps: [
      { atFailure: 1, action: "CLEAR_CACHE_RESTART" },
      { atFailure: 2, action: "NOTIFY_ONLY" },
    ],
  },
  {
    name: "Box is running hot",
    signal: "DEVICE_TEMP_HIGH",
    packageName: null,
    // 85°C is where these SoCs start throttling, which is the temperature at
    // which a box is still scanning and doing it slowly -- the failure this
    // catches before it becomes a stalled loop nobody can explain.
    config: { maxTempC: 85 },
    threshold: 3,
    cooldownSeconds: 3600,
    notifyChannels: [...NOTIFY_CHANNELS],
    notifyLevel: "WARN",
    // Telling you is the whole rule, and there is no honest second rung: no
    // action on the catalog cools a box down, and rebooting one does not --
    // it comes back to the same cupboard. The answer is air, and that is not
    // something a hub can send.
    steps: [{ atFailure: 1, action: "NOTIFY_ONLY" }],
  },

  // --- machines -------------------------------------------------------------
  // The four a VPS running Redroid containers is watched for. Their ladders are
  // shorter than the box ones above on purpose: the blast radius is different.
  // A box is one scanner, and a machine is every box on it -- so three of these
  // only tell you, and the fourth touches one container.

  {
    name: "Docker is down",
    signal: "HOST_DOCKER_DOWN",
    appliesTo: "HOST",
    packageName: null,
    config: {},
    // Two readings, so a daemon restart that the operator is doing by hand is
    // not announced as an outage.
    threshold: 2,
    cooldownSeconds: 1800,
    notifyChannels: [...NOTIFY_CHANNELS],
    // Every box on the machine is down at once, and none of them can be
    // started. There is no louder thing that can happen to a machine.
    notifyLevel: "CRITICAL",
    // Nothing else is possible. The agent answering means the machine is
    // reachable, and the one thing that could bring docker back is systemd on
    // the machine itself -- which a rule has no business racing.
    steps: [{ atFailure: 1, action: "NOTIFY_ONLY" }],
  },
  {
    name: "Machine is low on memory",
    signal: "HOST_MEMORY_LOW",
    appliesTo: "HOST",
    // Memory and swap together, which is what the hub compares: on these
    // machines swap is exactly what stands between a stack of Androids and the
    // OOM killer. Ten percent is roughly one more box's worth of headroom.
    config: { minFreePercent: 10 },
    packageName: null,
    // Three readings, because a box booting is a spike: Android takes most of
    // its memory in the first minute and hands some of it back afterwards.
    threshold: 3,
    cooldownSeconds: 1800,
    notifyChannels: [...NOTIFY_CHANNELS],
    notifyLevel: "WARN",
    // Telling you is the whole rule. The answer is fewer boxes or more swap,
    // and the OOM killer does not take the box that caused it -- so acting
    // here would mean restarting an innocent container to free memory for
    // whatever actually ate it.
    steps: [{ atFailure: 1, action: "NOTIFY_ONLY" }],
  },
  {
    name: "Machine is low on disk",
    signal: "HOST_DISK_LOW",
    appliesTo: "HOST",
    config: { minFreePercent: 10 },
    packageName: null,
    // A disk fills slowly, so two readings in a row is already a trend rather
    // than a spike -- and nothing here can be fixed in a hurry anyway.
    threshold: 2,
    cooldownSeconds: 3600,
    notifyChannels: [...NOTIFY_CHANNELS],
    notifyLevel: "WARN",
    steps: [{ atFailure: 1, action: "NOTIFY_ONLY" }],
  },
  {
    name: "A box on the machine is not running",
    signal: "REDROID_INSTANCE_DOWN",
    appliesTo: "HOST",
    packageName: null,
    config: {},
    threshold: 2,
    cooldownSeconds: 600,
    notifyChannels: [...NOTIFY_CHANNELS],
    notifyLevel: "WARN",
    steps: [
      { atFailure: 1, action: "NOTIFY_ONLY" },
      // One container, never the machine: every other box on it is working,
      // and this is the only remediation that knows the difference.
      { atFailure: 3, action: "RESTART_INSTANCE" },
    ],
  },
];

/**
 * Write the defaults this fleet has no answer for, all **disabled**.
 *
 * Keyed per signal rather than on an empty table. The empty-table test read as
 * the careful choice and was really a one-way door: every install that has
 * booted the hub once already has the box rules above, so a seed added in a
 * later release -- the four machine rules are the first -- could only ever
 * reach a fleet that did not exist yet. The fleets that run machines are
 * precisely the ones that already had rules.
 *
 * What it costs is worth saying plainly: a rule deleted on purpose comes back,
 * disabled, after the next deploy. Switching one off is what keeps it gone,
 * and that is the right way round -- a disabled rule in a list is noise, while
 * a signal nobody is watching because it shipped after their install is a
 * fleet with no answer at all.
 *
 * Disabled is the part that is not a trade. An upgrade that starts rebooting
 * boxes is the worst possible version of this feature, so somebody has to read
 * these and turn them on.
 */
export async function seedDefaultMonitorRules(): Promise<number> {
  const existing = await prisma.monitorRule.findMany({
    select: { signal: true },
    distinct: ["signal"],
  });
  const present = new Set<MonitorSignal>(existing.map((rule) => rule.signal));
  // One seed per signal, which is what makes "no rule names this signal" an
  // exact question. A fleet that renamed and retuned its copy keeps it: the
  // signal is named, so nothing is written beside it.
  const missing = SEEDS.filter((seed) => !present.has(seed.signal));
  if (missing.length === 0) return 0;

  // Continue the list rather than restart it. `position` is the order the
  // rules are shown in, and a seed landing at 0 would reshuffle a list
  // somebody has already arranged.
  const base = await prisma.monitorRule.count();

  for (const [index, seed] of missing.entries()) {
    await prisma.monitorRule.create({
      data: {
        name: seed.name,
        enabled: false,
        signal: seed.signal,
        appliesTo: seed.appliesTo ?? "BOX",
        packageName: seed.packageName,
        config: seed.config,
        threshold: seed.threshold,
        cooldownSeconds: seed.cooldownSeconds,
        notifyChannels: seed.notifyChannels,
        notifyLevel: seed.notifyLevel,
        position: base + index,
        steps: { create: seed.steps },
      },
    });
  }

  log.info(
    { count: missing.length, signals: missing.map((seed) => seed.signal) },
    "seeded the monitor rules this fleet was missing, all disabled",
  );
  return missing.length;
}

/** Its own hourly clock, so riding the five-second tick costs nothing. */
async function pruneEvents(retentionDays: number): Promise<void> {
  if (retentionDays <= 0) return;
  if (Date.now() - lastPruneAt < 3_600_000) return;
  lastPruneAt = Date.now();

  const { count } = await prisma.monitorEvent.deleteMany({
    where: { at: { lt: new Date(Date.now() - retentionDays * 86_400_000) } },
  });
  if (count > 0) log.debug({ count }, "pruned monitor events");
}
