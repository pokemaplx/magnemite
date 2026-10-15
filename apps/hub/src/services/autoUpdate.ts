import { prisma } from "@magnemite/db";
import { log } from "../log.js";
import { cacheVersion } from "./artifacts.js";
import { notInMaintenance } from "./maintenance.js";
import { createRollout } from "./rollouts.js";
import { nudge } from "./scheduler.js";
import { compareVersions } from "./sources/types.js";

const ACTIVE_ROLLOUT_STATUSES = ["PENDING", "CANARY", "SOAKING", "RUNNING", "PAUSED"] as const;

/**
 * Decide whether the newest approved version deserves an automatic rollout.
 *
 * Deliberately conservative: one rollout per target at a time, never a
 * downgrade, and nothing moves until the artifact is actually cached on the
 * VPS. The dispatch-time window check in the scheduler is what keeps an
 * out-of-hours rollout from waking the fleet at 3am.
 */
export async function runAutoUpdate(appTargetId: string) {
  const target = await prisma.appTarget.findUnique({ where: { id: appTargetId } });
  if (!target || !target.enabled || !target.autoUpdateEnabled) return null;

  const active = await prisma.rollout.count({
    where: {
      appVersion: { appTargetId },
      status: { in: [...ACTIVE_ROLLOUT_STATUSES] },
    },
  });
  if (active > 0) return null;

  // The target's own cooldown, not the fleet's: how soon after one automatic
  // rollout the next may start is a property of the app being shipped.
  if (target.updateCooldownMinutes > 0) {
    const lastAuto = await prisma.rollout.findFirst({
      where: { mode: "AUTO", finishedAt: { not: null }, appVersion: { appTargetId } },
      orderBy: { finishedAt: "desc" },
    });
    if (lastAuto?.finishedAt) {
      const readyAt = lastAuto.finishedAt.getTime() + target.updateCooldownMinutes * 60_000;
      if (readyAt > Date.now()) return null;
    }
  }

  const candidates = await prisma.appVersion.findMany({
    where: { appTargetId, approved: true, status: { in: ["DISCOVERED", "CACHING", "READY"] } },
  });
  if (candidates.length === 0) return null;

  // One row per build, whichever feed listed it, so newest simply wins.
  const sorted = [...candidates].sort((a, b) => compareVersions(b.version, a.version));
  const latest = sorted[0];
  if (!latest) return null;

  // Anything the fleet is already running, or ahead of, is not an update.
  // Parked boxes are left out of the count as well as out of the rollout. If
  // the only box behind is one somebody is working on, there is nothing to
  // ship: counting it would have this create a rollout every cycle that
  // `createRollout` then refuses for having no target, which is a loop of log
  // noise about a decision already made correctly.
  const installed = await prisma.devicePackage.findMany({
    where: {
      packageName: target.packageName,
      device: { approved: true, ...notInMaintenance() },
    },
    select: { versionName: true },
  });
  const behind = installed.filter(
    (p) => !p.versionName || compareVersions(latest.version, p.versionName) > 0,
  );
  if (behind.length === 0) return null;

  if (latest.status !== "READY") {
    log.info(
      { version: latest.version, feedId: latest.feedId },
      "auto-update: caching artifact before rollout",
    );
    await cacheVersion(latest.id);
  }

  const rollout = await createRollout({
    appVersionId: latest.id,
    mode: "AUTO",
    canaryCount: target.canaryCount,
    soakMinutes: target.soakMinutes,
    maxConcurrency: target.maxConcurrency,
    maxAttempts: target.maxAttempts,
    retryBackoffSeconds: target.retryBackoffSeconds,
    skipUpToDate: true,
    note: `auto-update to ${latest.version} (${latest.source.toLowerCase()})`,
  });

  log.info(
    { rolloutId: rollout.id, version: latest.version, devices: behind.length },
    "auto-update rollout created",
  );
  nudge();
  return rollout;
}
