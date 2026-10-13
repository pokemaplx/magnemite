import path from "node:path";
import type { InstallJob } from "@magnemite/protocol";
import { prisma } from "@magnemite/db";
import { getHubSettings } from "./hubSettings.js";
import { env } from "../env.js";
import { log } from "../log.js";
import { isOnline, sendTo } from "../registry.js";
import { hasWriteConfig, renderConfig } from "./deviceConfig.js";
import { ACTIVE_STATES, logJobEvent, recomputeRollout, requeueStalled } from "./jobs.js";
import { pruneMetrics } from "./metrics.js";
import { evaluate } from "./monitor.js";

const TICK_MS = 5_000;

let running = false;
let timer: NodeJS.Timeout | null = null;
/** Set when a tick is requested while one is already in flight. */
let rerun = false;

export function artifactUrl(artifactPath: string): string {
  return `${env.MAGNEMITE_PUBLIC_URL.replace(/\/$/, "")}/files/${path.basename(artifactPath)}`;
}

export function startScheduler() {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  log.info("scheduler started");
  void tick();
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * Ask the scheduler to run now — a device just came online, an operator
 * created a rollout, a job finished. Cheap and safe to call often.
 */
export function nudge() {
  void tick();
}

async function tick() {
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  try {
    const settings = await getHubSettings();
    await promoteSoakingRollouts();
    await requeueStalled(settings.jobStallTimeoutSeconds);
    // Keeps its own hourly clock, so riding the 5-second tick costs nothing.
    await pruneMetrics();
    // Same idea, on the heartbeat's clock — one pass per beat, since that is
    // how often a box has anything new to say. Returns immediately when
    // monitoring is off, which is how every fleet starts.
    await evaluate();
    await dispatchQueued(settings.maxConcurrentJobs);
  } catch (err) {
    log.error({ err }, "scheduler tick failed");
  } finally {
    running = false;
    if (rerun) {
      rerun = false;
      setImmediate(() => void tick());
    }
  }
}

/** A canary that passed its soak releases the rest of the fleet. */
async function promoteSoakingRollouts() {
  const soaking = await prisma.rollout.findMany({
    where: { status: "SOAKING", canaryPassedAt: { not: null } },
  });
  for (const rollout of soaking) {
    const readyAt = new Date(rollout.canaryPassedAt!.getTime() + rollout.soakMinutes * 60_000);
    if (readyAt <= new Date()) {
      await prisma.rollout.update({ where: { id: rollout.id }, data: { status: "RUNNING" } });
      log.info({ rolloutId: rollout.id }, "soak finished, releasing fleet");
    }
  }
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

async function dispatchQueued(maxConcurrentJobs: number) {
  const activeCount = await prisma.job.count({ where: { state: { in: ACTIVE_STATES } } });
  let capacity = maxConcurrentJobs - activeCount;
  if (capacity <= 0) return;

  const candidates = await prisma.job.findMany({
    where: {
      state: "QUEUED",
      rollout: { status: { in: ["CANARY", "RUNNING"] } },
      device: { approved: true },
      // A job that has just failed is held for its rollout's backoff. Filtered
      // here rather than skipped in the loop below so a held job does not eat
      // one of the 500 candidate slots on every tick.
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
    },
    include: {
      // `redroidInstance` because the config renderer substitutes
      // {{device.workers}} off it. Selected here rather than fetched inside
      // the loop: the candidate query already walks these rows, so it costs no
      // extra round trip, and a missing include would have been a placeholder
      // that silently refused on every container.
      device: { include: { group: true, redroidInstance: { select: { workers: true } } } },
      rollout: { include: { appVersion: { include: { appTarget: true } } } },
    },
    // Canaries first, then oldest rollout first, so one rollout drains before
    // the next one starts competing for slots.
    orderBy: [{ isCanary: "desc" }, { queuedAt: "asc" }],
    take: 500,
  });
  if (candidates.length === 0) return;

  // Per-group in-flight counts, for sites on a thin uplink.
  const groupActive = new Map<string, number>();
  const activeJobs = await prisma.job.findMany({
    where: { state: { in: ACTIVE_STATES } },
    select: { device: { select: { groupId: true } } },
  });
  for (const j of activeJobs) {
    const gid = j.device.groupId;
    if (gid) groupActive.set(gid, (groupActive.get(gid) ?? 0) + 1);
  }

  const rolloutActive = new Map<string, number>();

  for (const job of candidates) {
    if (capacity <= 0) break;

    // An offline box keeps its job queued; it gets dispatched the moment the
    // agent reconnects, no operator action needed.
    if (!isOnline(job.deviceId)) continue;

    const rollout = job.rollout;
    if (rollout.status === "CANARY" && !job.isCanary) continue;

    const target = rollout.appVersion.appTarget;
    if (rollout.mode === "AUTO" && !insideWindow(target.windowStart, target.windowEnd)) continue;

    const groupId = job.device.groupId;
    const groupLimit = job.device.group?.maxConcurrency ?? null;
    if (groupId && groupLimit !== null && (groupActive.get(groupId) ?? 0) >= groupLimit) continue;

    const rolloutLimit = rollout.maxConcurrency;
    if (rolloutLimit !== null && (rolloutActive.get(rollout.id) ?? 0) >= rolloutLimit) continue;

    const version = rollout.appVersion;
    if (!version.artifactPath || !version.sha256) {
      await logJobEvent(job.id, "artifact is not cached on the server", { level: "ERROR" });
      continue;
    }

    const message: InstallJob = {
      type: "install_job",
      jobId: job.id,
      packageName: target.packageName,
      url: artifactUrl(version.artifactPath),
      sha256: version.sha256,
      sizeBytes: Number(version.sizeBytes),
      version: version.version,
      forceClean: rollout.forceClean,
      // A rollout may carry its own hooks — a manual deploy of some other app
      // has to stop and start *that* app, not whatever the group stops for the
      // watched one. Falls back to the group when it does not.
      //
      // `hookMode` then decides which of the two survive. It is not a third
      // override but a veto over both, because the case it exists for is a box
      // where the hooks have nothing to act on: on a bare box the pre-install
      // hook stops a scanner that is not installed, and on the deploy before
      // the MITM even the post-install hook has nothing to start.
      preInstallHook:
        rollout.hookMode === "NORMAL"
          ? (rollout.preInstallHook ?? job.device.group?.preInstallHook ?? null)
          : null,
      postInstallHook:
        rollout.hookMode === "NONE"
          ? null
          : (rollout.postInstallHook ?? job.device.group?.postInstallHook ?? null),
      extraSplits: [],
      timeoutSeconds: 3600,
    };

    // The config belongs to the MITM, so it rides the install of the MITM and
    // nothing else: putting a launcher on a box whose group runs Aegis must
    // not rewrite Aegis's config. The package check does that on its own, and
    // `writeConfig` is the deliberate opt-out on top of it — the deploy that
    // reinstalls a crashed scanner, or rolls a build back, over a config on the
    // box that must survive.
    //
    // The candidate query already includes the device and its group, so this
    // costs no extra round trip inside the dispatch loop.
    if (rollout.writeConfig && job.device.group?.mitmPackageName === target.packageName) {
      // The rollout's own config when it carries one, the group's otherwise --
      // null here means "fall back", exactly as it does for the hooks above.
      const config = renderConfig(job.device, rollout.mitmConfig);
      if (config?.ok) {
        message.config = config.file;
      } else if (config) {
        // The install still goes ahead. A box left on the previous config is
        // worth a warning; a box left without the app at all is worse.
        await logJobEvent(job.id, `config not sent: ${config.reason}`, { level: "WARN" });
      }
      if (config?.ok && !hasWriteConfig(job.device.capabilities)) {
        await logJobEvent(
          job.id,
          "config not written: this box's agent is too old, and takes an agent update first",
          { level: "WARN" },
        );
        message.config = null;
      }
    }

    const attempt = job.attempt + 1;
    await prisma.job.update({
      where: { id: job.id },
      data: {
        state: "DISPATCHED",
        attempt,
        dispatchedAt: new Date(),
        heartbeatAt: new Date(),
        progress: 0,
      },
    });

    if (!sendTo(job.deviceId, message)) {
      // The socket died between the online check and the write. Put it back
      // and let the next tick try again.
      await prisma.job.update({
        where: { id: job.id },
        data: { state: "QUEUED", attempt: job.attempt, dispatchedAt: null, heartbeatAt: null },
      });
      continue;
    }

    await logJobEvent(job.id, `dispatched (attempt ${attempt}) → ${version.version}`, {
      phase: "DISPATCHED",
    });

    capacity -= 1;
    if (groupId) groupActive.set(groupId, (groupActive.get(groupId) ?? 0) + 1);
    rolloutActive.set(rollout.id, (rolloutActive.get(rollout.id) ?? 0) + 1);
    await recomputeRollout(rollout.id);
  }
}
