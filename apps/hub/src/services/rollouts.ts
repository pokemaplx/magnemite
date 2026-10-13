import { type RolloutHookMode, type RolloutMode, prisma } from "@magnemite/db";
import { bus } from "../bus.js";
import { log } from "../log.js";
import { isOnline } from "../registry.js";
import { logJobEvent, recomputeRollout } from "./jobs.js";

export type CreateRolloutInput = {
  appVersionId: string;
  /** Explicit device selection. Omit to target every approved device. */
  deviceIds?: string[];
  mode?: RolloutMode;
  forceClean?: boolean;
  /** Overrides the device group's hooks for this rollout only. */
  preInstallHook?: string | null;
  postInstallHook?: string | null;
  /** Which of the resolved hooks may run. Defaults to both. */
  hookMode?: RolloutHookMode;
  /** False leaves the group's MITM config alone. Defaults to writing it. */
  writeConfig?: boolean;
  /**
   * This rollout's MITM config, overriding the device group's for these
   * installs only. Null or absent falls back to the group's, like the hooks.
   */
  mitmConfig?: string | null;
  canaryCount?: number;
  soakMinutes?: number;
  maxConcurrency?: number | null;
  maxAttempts?: number;
  retryBackoffSeconds?: number;
  /** Devices already on the target version get a SKIPPED job instead of a real one. */
  skipUpToDate?: boolean;
  createdById?: string | null;
  note?: string | null;
};

export async function createRollout(input: CreateRolloutInput) {
  const appVersion = await prisma.appVersion.findUnique({
    where: { id: input.appVersionId },
    include: { appTarget: true },
  });
  if (!appVersion) throw new Error("app version not found");
  if (appVersion.status !== "READY" || !appVersion.artifactPath || !appVersion.sha256) {
    throw new Error(
      `version ${appVersion.version} is not cached yet (status ${appVersion.status}) — cache it before rolling out`,
    );
  }

  const devices = await prisma.device.findMany({
    where: {
      // A host installs no APKs and has no `pm` to install them with, so it is
      // never a rollout target -- not even when an explicit id list names one,
      // which is why this sits outside the spread rather than inside it.
      kind: "BOX",
      approved: true,
      ...(input.deviceIds?.length ? { id: { in: input.deviceIds } } : {}),
    },
    include: {
      packages: { where: { packageName: appVersion.appTarget.packageName } },
    },
    orderBy: { name: "asc" },
  });

  if (devices.length === 0) throw new Error("no approved devices matched the selection");

  const target = appVersion.appTarget;
  const canaryCount = input.canaryCount ?? 0;
  const skipUpToDate = input.skipUpToDate ?? true;

  // Canaries should be boxes that can actually start now, otherwise the whole
  // fleet sits behind an offline device waiting for a soak that never begins.
  const eligible = devices.filter(
    (d) => !skipUpToDate || d.packages[0]?.versionName !== appVersion.version,
  );
  const ordered = [...eligible].sort((a, b) => {
    const onlineDiff = Number(isOnline(b.id)) - Number(isOnline(a.id));
    return onlineDiff !== 0 ? onlineDiff : a.name.localeCompare(b.name);
  });
  const canaryIds = new Set(ordered.slice(0, canaryCount).map((d) => d.id));

  const rollout = await prisma.rollout.create({
    data: {
      appVersionId: appVersion.id,
      mode: input.mode ?? "MANUAL",
      // With canaries the fleet waits behind them; without, everything is
      // free to dispatch immediately.
      status: canaryIds.size > 0 ? "CANARY" : "RUNNING",
      forceClean: input.forceClean ?? false,
      preInstallHook: input.preInstallHook?.trim() || null,
      postInstallHook: input.postInstallHook?.trim() || null,
      hookMode: input.hookMode ?? "NORMAL",
      writeConfig: input.writeConfig ?? true,
      mitmConfig: input.mitmConfig?.trim() || null,
      canaryCount: canaryIds.size,
      soakMinutes: input.soakMinutes ?? 0,
      maxConcurrency: input.maxConcurrency ?? null,
      maxAttempts: input.maxAttempts ?? target.maxAttempts,
      retryBackoffSeconds: input.retryBackoffSeconds ?? target.retryBackoffSeconds,
      createdById: input.createdById ?? null,
      note: input.note ?? null,
      startedAt: new Date(),
      jobs: {
        create: devices.map((device) => {
          const current = device.packages[0]?.versionName ?? null;
          const upToDate = skipUpToDate && current === appVersion.version;
          return {
            deviceId: device.id,
            state: upToDate ? ("SKIPPED" as const) : ("QUEUED" as const),
            isCanary: canaryIds.has(device.id),
            fromVersion: current,
            toVersion: appVersion.version,
            finishedAt: upToDate ? new Date() : null,
          };
        }),
      },
    },
    include: { jobs: true },
  });

  for (const job of rollout.jobs) {
    if (job.state === "SKIPPED") {
      await logJobEvent(job.id, `already on ${appVersion.version}`, { phase: "SKIPPED" });
    }
  }

  log.info(
    {
      rolloutId: rollout.id,
      version: appVersion.version,
      devices: rollout.jobs.length,
      canary: canaryIds.size,
    },
    "rollout created",
  );
  bus.publish({ kind: "rollout", rolloutId: rollout.id });
  await recomputeRollout(rollout.id);
  return rollout;
}

export async function cancelRollout(rolloutId: string) {
  const jobs = await prisma.job.findMany({
    where: { rolloutId, state: { notIn: ["SUCCESS", "FAILED", "CANCELLED", "SKIPPED"] } },
    select: { id: true },
  });

  await prisma.job.updateMany({
    where: { id: { in: jobs.map((j) => j.id) } },
    data: { state: "CANCELLED", finishedAt: new Date() },
  });
  await prisma.rollout.update({
    where: { id: rolloutId },
    data: { status: "CANCELLED", finishedAt: new Date() },
  });

  bus.publish({ kind: "rollout", rolloutId });
  return jobs.length;
}

/** Operator overrides a canary failure, or un-pauses a paused rollout. */
export async function resumeRollout(rolloutId: string) {
  const rollout = await prisma.rollout.findUnique({ where: { id: rolloutId } });
  if (!rollout) throw new Error("rollout not found");
  if (rollout.status !== "PAUSED" && rollout.status !== "SOAKING") {
    throw new Error(`rollout is ${rollout.status}, nothing to resume`);
  }
  await prisma.rollout.update({
    where: { id: rolloutId },
    data: { status: "RUNNING", canaryPassedAt: rollout.canaryPassedAt ?? new Date() },
  });
  bus.publish({ kind: "rollout", rolloutId });
}
