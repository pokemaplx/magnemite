import {
  type InstallMode,
  type JobState,
  type LogLevel,
  type RolloutStatus,
  prisma,
} from "@magnemite/db";
import { bus } from "../bus.js";
import { log } from "../log.js";

/** States the agent moves through while it is actually working on a job. */
export const ACTIVE_STATES: JobState[] = [
  "DISPATCHED",
  "DOWNLOADING",
  "EXTRACTING",
  "INSTALLING",
  "VERIFYING",
];

export const TERMINAL_STATES: JobState[] = ["SUCCESS", "FAILED", "CANCELLED", "SKIPPED"];

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.includes(state);
}

export async function logJobEvent(
  jobId: string,
  message: string,
  opts: { level?: LogLevel; phase?: JobState } = {},
) {
  await prisma.jobEvent.create({
    data: { jobId, message, level: opts.level ?? "INFO", phase: opts.phase ?? null },
  });
}

function publishJob(job: { id: string; rolloutId: string; deviceId: string }) {
  bus.publish({ kind: "job", jobId: job.id, rolloutId: job.rolloutId, deviceId: job.deviceId });
}

/**
 * Progress report from the agent. Ignored once the job is terminal, so a
 * message that crosses paths with a cancel can't resurrect it.
 */
export async function applyProgress(
  jobId: string,
  state: JobState,
  progress: number,
  message?: string | null,
) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return;
  if (isTerminal(job.state)) return;

  const updated = await prisma.job.update({
    where: { id: jobId },
    data: {
      state,
      progress: Math.max(0, Math.min(100, progress)),
      heartbeatAt: new Date(),
      startedAt: job.startedAt ?? new Date(),
    },
  });

  if (message) await logJobEvent(jobId, message, { phase: state });
  publishJob(updated);
}

export type JobOutcome = {
  ok: boolean;
  installMode?: InstallMode | null;
  dataWiped?: boolean;
  installedVersion?: string | null;
  error?: string | null;
};

/**
 * Final word from the agent. On failure the job goes back to QUEUED while it
 * still has attempts left, so a box that dropped its uplink mid-download gets
 * picked up again on the next tick instead of needing a human.
 */
export async function completeJob(jobId: string, outcome: JobOutcome) {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { rollout: true },
  });
  if (!job || isTerminal(job.state)) return;

  const dataWiped = outcome.dataWiped ?? job.dataWiped;

  if (outcome.ok) {
    const updated = await prisma.job.update({
      where: { id: jobId },
      data: {
        state: "SUCCESS",
        progress: 100,
        finishedAt: new Date(),
        installMode: outcome.installMode ?? job.installMode,
        dataWiped,
        lastError: null,
      },
    });
    await logJobEvent(jobId, `installed ${outcome.installedVersion ?? job.toVersion}`, {
      phase: "SUCCESS",
    });
    publishJob(updated);
  } else {
    const canRetry = job.attempt < job.rollout.maxAttempts;
    const retryAt = canRetry ? nextAttemptAt(job.rollout.retryBackoffSeconds, job.attempt) : null;
    const updated = await prisma.job.update({
      where: { id: jobId },
      data: {
        state: canRetry ? "QUEUED" : "FAILED",
        progress: 0,
        lastError: outcome.error ?? "unknown error",
        dataWiped,
        installMode: outcome.installMode ?? job.installMode,
        nextAttemptAt: retryAt,
        finishedAt: canRetry ? null : new Date(),
      },
    });
    await logJobEvent(jobId, outcome.error ?? "job failed", {
      level: "ERROR",
      phase: canRetry ? "QUEUED" : "FAILED",
    });
    if (canRetry) {
      const held = retryAt ? ` in ${Math.round((retryAt.getTime() - Date.now()) / 1000)}s` : "";
      await logJobEvent(
        jobId,
        `re-queued for attempt ${job.attempt + 1}/${job.rollout.maxAttempts}${held}`,
        { phase: "QUEUED" },
      );
    }
    publishJob(updated);
  }

  await recomputeRollout(job.rolloutId);
}

/** Operator pressed retry on a job that had already given up. */
export async function retryJob(jobId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return null;
  if (!isTerminal(job.state) && job.state !== "QUEUED") return job;

  const updated = await prisma.job.update({
    where: { id: jobId },
    data: {
      state: "QUEUED",
      progress: 0,
      // Reset the counter: a manual retry is a fresh decision, not a
      // continuation of the automatic attempts that already gave up.
      attempt: 0,
      // An operator pressing retry is not waiting out a backoff they did not
      // set; the point of the button is that it goes now.
      nextAttemptAt: null,
      lastError: null,
      queuedAt: new Date(),
      dispatchedAt: null,
      startedAt: null,
      heartbeatAt: null,
      finishedAt: null,
    },
  });
  await logJobEvent(jobId, "retry requested by operator", { phase: "QUEUED" });
  publishJob(updated);
  // A rollout whose jobs had all finished is COMPLETED, and the scheduler only
  // dispatches from running ones -- so a retried job in it sat QUEUED for good.
  // That is every one-box rollout the moment its only job fails, a join install
  // among them, and it made Retry a button that did nothing. Reopened here, it
  // completes again when this job does, and releases what was waiting on it.
  const reopened = await prisma.rollout.updateMany({
    where: { id: job.rolloutId, status: "COMPLETED" },
    data: { status: "RUNNING", finishedAt: null },
  });
  if (reopened.count > 0) bus.publish({ kind: "rollout", rolloutId: job.rolloutId });
  await recomputeRollout(job.rolloutId);
  return updated;
}

export async function retryFailedJobs(rolloutId: string) {
  const failed = await prisma.job.findMany({
    where: { rolloutId, state: "FAILED" },
    select: { id: true },
  });
  for (const job of failed) await retryJob(job.id);
  return failed.length;
}

export async function cancelJob(jobId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || isTerminal(job.state)) return job;

  const updated = await prisma.job.update({
    where: { id: jobId },
    data: { state: "CANCELLED", finishedAt: new Date() },
  });
  await logJobEvent(jobId, "cancelled", { phase: "CANCELLED" });
  publishJob(updated);
  await recomputeRollout(job.rolloutId);
  return updated;
}

/**
 * Ceiling on the doubling, so a rollout with a generous base and a high
 * attempt count cannot park a job for the rest of the afternoon.
 */
const RETRY_BACKOFF_CEILING_SECONDS = 30 * 60;

/**
 * When a job that has just failed its Nth attempt may be dispatched again.
 *
 * Doubles per attempt from the rollout's base: the first retry is for the
 * transient thing — a box mid-restart, an uplink that dropped — and gets the
 * short wait, while a job still failing on its third attempt is telling us
 * something slower is wrong and there is nothing to gain by asking again
 * immediately.
 *
 * Null when the rollout sets no backoff, which keeps the old behaviour of
 * retrying on the next tick.
 */
function nextAttemptAt(backoffSeconds: number, attempt: number): Date | null {
  if (backoffSeconds <= 0) return null;
  const seconds = Math.min(
    backoffSeconds * 2 ** Math.max(0, attempt - 1),
    RETRY_BACKOFF_CEILING_SECONDS,
  );
  return new Date(Date.now() + seconds * 1000);
}

/**
 * Re-queue jobs whose agent went quiet. Covers the box that was unplugged
 * mid-install and the socket that died without a close frame.
 */
export async function requeueStalled(stallTimeoutSeconds: number) {
  const cutoff = new Date(Date.now() - stallTimeoutSeconds * 1000);
  const stalled = await prisma.job.findMany({
    where: {
      state: { in: ACTIVE_STATES },
      OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, dispatchedAt: { lt: cutoff } }],
    },
    include: { rollout: true },
  });

  for (const job of stalled) {
    const canRetry = job.attempt < job.rollout.maxAttempts;
    await prisma.job.update({
      where: { id: job.id },
      data: {
        state: canRetry ? "QUEUED" : "FAILED",
        progress: 0,
        lastError: `agent went silent for over ${stallTimeoutSeconds}s in ${job.state}`,
        nextAttemptAt: canRetry
          ? nextAttemptAt(job.rollout.retryBackoffSeconds, job.attempt)
          : null,
        finishedAt: canRetry ? null : new Date(),
      },
    });
    await logJobEvent(job.id, `stalled in ${job.state}, ${canRetry ? "re-queued" : "failed"}`, {
      level: "WARN",
    });
    publishJob(job);
    await recomputeRollout(job.rolloutId);
  }

  if (stalled.length) log.warn({ count: stalled.length }, "re-queued stalled jobs");
  return stalled.length;
}

/**
 * Whether a rollout finished with every job a success -- a SKIPPED job counts,
 * since the box already had the build. What a rollout waiting on this one is
 * waiting for.
 */
export function rolloutSucceeded(rollout: {
  status: RolloutStatus;
  jobs: { state: JobState }[];
}): boolean {
  return (
    rollout.status === "COMPLETED" &&
    rollout.jobs.every((job) => job.state === "SUCCESS" || job.state === "SKIPPED")
  );
}

/**
 * Start the rollouts that were waiting for this one, now that it succeeded.
 *
 * One that finished with a failure releases nothing: its waiters stay PENDING,
 * which is the point of waiting, and a retry of the failed job is what
 * completes it again and lets them go.
 */
async function releaseWaiting(rolloutId: string) {
  const waiting = await prisma.rollout.findMany({
    where: { waitsForId: rolloutId, status: "PENDING" },
    select: { id: true, canaryCount: true },
  });
  for (const rollout of waiting) {
    await prisma.rollout.update({
      where: { id: rollout.id },
      data: { status: rollout.canaryCount > 0 ? "CANARY" : "RUNNING", startedAt: new Date() },
    });
    const jobs = await prisma.job.findMany({
      where: { rolloutId: rollout.id, state: "QUEUED" },
      select: { id: true },
    });
    for (const job of jobs) {
      await logJobEvent(job.id, "what this waited for is installed, starting", { phase: "QUEUED" });
    }
    log.info({ rolloutId: rollout.id, after: rolloutId }, "released a waiting rollout");
    bus.publish({ kind: "rollout", rolloutId: rollout.id });
  }
}

/**
 * Roll the per-job outcomes up into the rollout state machine:
 * canary finishes -> soak -> full fleet -> done, with a failed canary
 * parking the rollout instead of pushing a bad build to the whole fleet.
 */
export async function recomputeRollout(rolloutId: string) {
  const rollout = await prisma.rollout.findUnique({
    where: { id: rolloutId },
    include: { jobs: { select: { state: true, isCanary: true } } },
  });
  if (!rollout) return;
  if (["COMPLETED", "CANCELLED"].includes(rollout.status)) return;

  const jobs = rollout.jobs;
  const canary = jobs.filter((j) => j.isCanary);
  const allDone = jobs.every((j) => isTerminal(j.state));

  let status: RolloutStatus = rollout.status;
  const data: { status?: RolloutStatus; canaryPassedAt?: Date; finishedAt?: Date } = {};

  if (rollout.status === "CANARY" && canary.length > 0) {
    const canaryDone = canary.every((j) => isTerminal(j.state));
    if (canaryDone) {
      const canaryFailed = canary.some((j) => j.state === "FAILED");
      if (canaryFailed) {
        status = "PAUSED";
      } else if (canary.some((j) => j.state === "SUCCESS")) {
        data.canaryPassedAt = new Date();
        status = rollout.soakMinutes > 0 ? "SOAKING" : "RUNNING";
      }
    }
  }

  if (allDone && !["PAUSED"].includes(status)) {
    status = "COMPLETED";
    data.finishedAt = new Date();
  }

  if (status !== rollout.status || Object.keys(data).length > 0) {
    await prisma.rollout.update({ where: { id: rolloutId }, data: { ...data, status } });
    bus.publish({ kind: "rollout", rolloutId });
  }

  if (status === "COMPLETED" && rolloutSucceeded({ status, jobs })) {
    await releaseWaiting(rolloutId);
  }
}
