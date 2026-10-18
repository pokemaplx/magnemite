import {
  JOIN_ROLLOUT_NOTE,
  type JobState,
  type NotifyEventId,
  type RolloutMode,
} from "@magnemite/db";
import { compareVersions } from "./sources/types.js";

/**
 * When a fleet event is worth a message at all — the decisions behind
 * `fleetEvents.ts`, apart from the wording.
 *
 * Their own module because they are the part that can be wrong in a way that
 * costs something: a rule that fires twice, or on the wrong thing, is either a
 * phone buzzing all night or an operator who mutes the channel and misses the
 * one that mattered. Nothing here touches the network or the environment, so
 * the tests can hold each of them to its word.
 */

type RolloutFacts = {
  mode: RolloutMode;
  note: string | null;
  jobs: { state: JobState }[];
};

/**
 * Which "started" event a rollout that was just created is, or null when
 * there is nothing to say.
 */
export function startedEvent(rollout: RolloutFacts): NotifyEventId | null {
  // A box joining its group is given its installs as one-box rollouts, and a
  // new machine is ten boxes at once. Success is the expected, quiet path for
  // those; only a failure is worth a message, and it gets its own event.
  if (rollout.note === JOIN_ROLLOUT_NOTE) return null;
  // Every box already had the build, so the rollout completed in the same
  // breath it was created. A start and a finish for no work at all would be
  // two messages about nothing.
  if (!rollout.jobs.some((job) => job.state !== "SKIPPED")) return null;
  return rollout.mode === "AUTO" ? "rolloutAutoStarted" : "rolloutStarted";
}

/**
 * Which event a rollout that has just reached COMPLETED is, or null.
 *
 * A failed job anywhere makes it a failure, whatever else succeeded — that is
 * the rollout an operator has to go and look at.
 */
export function settledEvent(rollout: Omit<RolloutFacts, "mode">): NotifyEventId | null {
  const failed = rollout.jobs.some((job) => job.state === "FAILED");
  const installed = rollout.jobs.some((job) => job.state === "SUCCESS");
  // Nothing installed and nothing failed: every job was skipped or cancelled,
  // which is either no work or somebody's own decision, and neither is news.
  if (!failed && !installed) return null;
  if (rollout.note === JOIN_ROLLOUT_NOTE) return failed ? "joinInstallFailed" : null;
  return failed ? "rolloutFailed" : "rolloutSucceeded";
}

/**
 * The newest of the builds a poll just found, if it is news: newer than every
 * build already known for the target. Null otherwise.
 *
 * The second half is what keeps a source added today from announcing the last
 * two years of releases. Its first poll lists them all, they are all new rows,
 * and none of them is newer than what the fleet already has.
 */
export function newestIfNews(created: string[], known: string[]): string | null {
  if (created.length === 0) return null;
  const newest = created.reduce((best, version) =>
    compareVersions(version, best) > 0 ? version : best,
  );
  return known.every((version) => compareVersions(newest, version) > 0) ? newest : null;
}

/**
 * Consecutive failed passes before a source counts as failing.
 *
 * Two, because one is noise — a mirror answering 502 for a minute while it
 * deploys — and because the first poll after a hub restart has no memory of
 * the one before it. A restart is every file save in development, so with a
 * threshold of one, editing the hub would announce every broken feed again.
 */
export const SOURCE_FAILING_PASSES = 2;

export type SourceState = { streak: number; announced: boolean };

/**
 * One poll pass of a source, folded into what is known about it, and what —
 * if anything — to say.
 *
 * A failure is announced once per outage, not once per pass; the all-clear
 * only follows a failure that was announced, so a single bad pass that never
 * reached the threshold recovers in silence.
 */
export function nextSourceState(
  previous: SourceState | undefined,
  ok: boolean,
): { state: SourceState; say: "failing" | "recovered" | null } {
  const before = previous ?? { streak: 0, announced: false };
  if (ok) {
    return { state: { streak: 0, announced: false }, say: before.announced ? "recovered" : null };
  }
  const streak = before.streak + 1;
  if (!before.announced && streak >= SOURCE_FAILING_PASSES) {
    return { state: { streak, announced: true }, say: "failing" };
  }
  return { state: { streak, announced: before.announced }, say: null };
}
