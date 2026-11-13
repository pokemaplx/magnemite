import type { NotifyEventId } from "@magnemite/db";

/**
 * What the dashboard calls each fleet event, for the matrix on Settings →
 * Notifications.
 *
 * The ids, their order and their defaults live in the database package, where
 * the hub reads them too; the words live here, because they are the
 * dashboard's. Typed as a `Record` over the ids so an event added there fails
 * to compile here rather than appearing as a row with no name. A type-only
 * import, so none of Prisma comes with it into the browser.
 *
 * The hint is the one line an operator needs to decide whether they want it —
 * mostly, how often it can fire.
 */

export type NotifyEventGroup = "Rollouts" | "Builds" | "Machines" | "Boxes";

export const NOTIFY_EVENT_GROUPS: NotifyEventGroup[] = ["Rollouts", "Builds", "Machines", "Boxes"];

export const NOTIFY_EVENT_META: Record<
  NotifyEventId,
  { group: NotifyEventGroup; label: string; hint: string }
> = {
  rolloutAutoStarted: {
    group: "Rollouts",
    label: "Auto-update started a rollout",
    hint: "A newer approved build, and boxes behind it.",
  },
  rolloutStarted: {
    group: "Rollouts",
    label: "Rollout or manual deploy started",
    hint: "Started by anyone, from Fleet or Manual deploy.",
  },
  rolloutSucceeded: {
    group: "Rollouts",
    label: "Rollout finished",
    hint: "Every box took the build — how many, and how long it took.",
  },
  rolloutFailed: {
    group: "Rollouts",
    label: "Rollout finished with failures",
    hint: "Names the boxes that failed, and why.",
  },
  rolloutPaused: {
    group: "Rollouts",
    label: "Canary failed, rollout paused",
    hint: "Nothing else gets the build until somebody resumes or cancels it.",
  },
  buildDiscovered: {
    group: "Builds",
    label: "New build found",
    hint: "The newest per app, once per poll. A new source never announces its history.",
  },
  buildCacheFailed: {
    group: "Builds",
    label: "Build failed to download",
    hint: "Auto-update passes over it until it is retried.",
  },
  sourceFailing: {
    group: "Builds",
    label: "Version source failing",
    hint: "After two failed polls in a row, and once more when it recovers.",
  },
  machineReady: {
    group: "Machines",
    label: "Machine set up",
    hint: "A provisioned machine dialled in, or a setup re-run finished.",
  },
  machineSetupFailed: {
    group: "Machines",
    label: "Machine setup failed",
    hint: "Over SSH, on a re-run, or cut short by a hub restart.",
  },
  convergeFailed: {
    group: "Machines",
    label: "Containers failed to apply",
    hint: "A machine could not run what it was told to, with docker's output.",
  },
  joinInstallFailed: {
    group: "Boxes",
    label: "New box failed its group install",
    hint: "One message per build, not one per box of a new machine.",
  },
  agentUpdateFailed: {
    group: "Boxes",
    label: "Agent update failed",
    hint: "Once per agent version — a broken release is one message, not one per box.",
  },
};
