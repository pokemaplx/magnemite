import "server-only";
import { type DeviceStatus, type JobState, JOIN_ROLLOUT_NOTE } from "@magnemite/db";
import { type SetupFacts, setupView } from "@/lib/instance-setup";

/**
 * The database half of `instance-setup.ts`: what the Machines pages select for
 * each instance's box, and how a row becomes the facts the stages are read
 * from. Apart from the pure half so that half stays importable by a client
 * component.
 */

/**
 * The box's join installs, for the last stage of its setup.
 *
 * A day back rather than from each instance's `requestedAt`, which a nested
 * select cannot take per row; `setupView` drops the ones from before the
 * instance was asked for. A box has two or three of these, so a day is cheap.
 */
export function setupJobsSelect(now = Date.now()) {
  return {
    where: {
      queuedAt: { gte: new Date(now - 24 * 60 * 60 * 1000) },
      rollout: { note: JOIN_ROLLOUT_NOTE },
    },
    orderBy: { queuedAt: "asc" as const },
    select: {
      state: true,
      progress: true,
      nextAttemptAt: true,
      queuedAt: true,
      rollout: {
        select: {
          appVersion: { select: { version: true, appTarget: { select: { displayName: true } } } },
        },
      },
    },
  };
}

type SetupJobRow = {
  state: JobState;
  progress: number;
  nextAttemptAt: Date | null;
  queuedAt: Date;
  rollout: { appVersion: { version: string; appTarget: { displayName: string } } };
};

/** What one instance is doing, from its row, its box and its machine. */
export function instanceSetup(
  instance: {
    requestedAt: Date | null;
    containerState: string | null;
    device: { status: DeviceStatus; jobs: SetupJobRow[] } | null;
  },
  machine: {
    name: string;
    status: DeviceStatus;
    convergingSince: Date | null;
    lastError: string | null;
    lastErrorAt: Date | null;
  },
  now = Date.now(),
) {
  const facts: SetupFacts = {
    requestedAt: instance.requestedAt?.toISOString() ?? null,
    containerState: instance.containerState,
    boxOnline: instance.device?.status === "ONLINE",
    installs: (instance.device?.jobs ?? []).map((job) => ({
      app: `${job.rollout.appVersion.appTarget.displayName} ${job.rollout.appVersion.version}`,
      state: job.state,
      progress: job.progress,
      heldUntil: job.nextAttemptAt?.toISOString() ?? null,
      queuedAt: job.queuedAt.toISOString(),
    })),
    machine: {
      name: machine.name,
      online: machine.status === "ONLINE",
      convergingSince: machine.convergingSince?.toISOString() ?? null,
      lastError: machine.lastError,
      lastErrorAt: machine.lastErrorAt?.toISOString() ?? null,
    },
  };
  return setupView(facts, now);
}
