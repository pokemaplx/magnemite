import {
  type JobState,
  type MonitorLevel,
  type NotifyEventId,
  type RolloutMode,
  prisma,
} from "@magnemite/db";
import { LEVEL_ICON, type Notice, type NoticeField, clamp } from "./alerts.js";
import { announce } from "./notify.js";
import {
  type SourceState,
  newestIfNews,
  nextSourceState,
  settledEvent,
  startedEvent,
} from "./fleetEventRules.js";

/**
 * The fleet telling an operator what it did: rollouts starting and finishing,
 * builds found or refused, machines set up or failing.
 *
 * One function per moment, called from the code that made it happen. Each is
 * fire-and-forget — it returns nothing, never throws, and does its reading
 * only after `announce` has established that somebody wants to hear it — so a
 * caller adds one line and none of its own behaviour depends on this file.
 * Most of them are called from places that must not wait: a job finishing
 * inside a socket handler, a poll pass, a converge result.
 *
 * What makes something an *event* rather than a state is the caller's half of
 * the contract: these are called on transitions, once. The rollout ones from
 * the winner of a compare-and-set, the machine one from the write that
 * claimed the bootstrap. Anything here that is fed from something periodic —
 * a poll, a sweep — carries its own memory of what it already said.
 *
 * Imports nothing that imports it. `jobs.ts`, `rollouts.ts`, `redroid.ts` and
 * `hostBootstrap.ts` all call in here, and a cycle between any of them leaves
 * one half-initialised at boot, so whatever this needs from them it reads off
 * the database itself.
 */

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

type NoticeInput = {
  level?: MonitorLevel;
  icon?: string;
  title: string;
  /** Empty values are dropped, so a builder can list a fact that may not apply. */
  fields: NoticeField[];
  /** What to say when there are no facts to list. */
  summary?: string;
  detail?: string | null;
  path: string;
  tag: string;
  footer: string;
  quiet?: boolean;
};

/**
 * A notice from a list of facts: Discord gets them as fields, the text
 * channels as one "Name: value" line each, in the same order — which is why
 * the builders below put the thing an operator decides on first.
 */
function notice(input: NoticeInput): Notice {
  const fields = input.fields.filter((field) => field.value !== "");
  const lines = fields.map((field) => `${field.name}: ${field.value}`);
  if (input.detail) lines.push(clamp(input.detail, 400));
  const level = input.level ?? "INFO";
  return {
    level,
    // Always explicit, even when it is just the level's: ntfy puts its own
    // emoji tags in front of a title, and a notice that brings an icon sends
    // none — otherwise a finished rollout would arrive as "✅ ✅".
    icon: input.icon ?? LEVEL_ICON[level],
    title: input.title,
    // ntfy shows an empty message as the topic name, which reads like a bug.
    body: lines.join("\n") || input.summary || input.title,
    fields,
    detail: input.detail ?? null,
    path: input.path,
    tag: input.tag,
    footer: input.footer,
    quiet: input.quiet,
  };
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function took(from: Date | null, to: Date | null): string {
  if (!from || !to) return "";
  const minutes = Math.round((to.getTime() - from.getTime()) / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
}

/** Fire one event without letting the caller wait on it or see it fail. */
function fire(event: NotifyEventId, build: () => Notice | null | Promise<Notice | null>): void {
  void announce(event, build);
}

// ---------------------------------------------------------------------------
// Rollouts
// ---------------------------------------------------------------------------

async function loadRollout(rolloutId: string) {
  return prisma.rollout.findUnique({
    where: { id: rolloutId },
    include: {
      appVersion: {
        select: {
          version: true,
          appTarget: {
            select: { displayName: true, manual: true, windowStart: true, windowEnd: true },
          },
        },
      },
      createdBy: { select: { name: true, email: true } },
      waitsFor: {
        select: {
          appVersion: { select: { version: true, appTarget: { select: { displayName: true } } } },
        },
      },
      jobs: {
        select: {
          state: true,
          isCanary: true,
          lastError: true,
          device: { select: { id: true, name: true, group: { select: { name: true } } } },
        },
        orderBy: { device: { name: "asc" } },
      },
    },
  });
}

type LoadedRollout = NonNullable<Awaited<ReturnType<typeof loadRollout>>>;

/** "Auto-update", "Manual deploy" or "Rollout" — what the operator called it. */
function rolloutKind(rollout: LoadedRollout): string {
  if (rollout.mode === "AUTO") return "Auto-update";
  return rollout.appVersion.appTarget.manual ? "Manual deploy" : "Rollout";
}

function rolloutSubject(rollout: LoadedRollout): string {
  return `${rollout.appVersion.appTarget.displayName} ${rollout.appVersion.version}`;
}

function startedBy(rollout: LoadedRollout): string {
  if (rollout.mode === "AUTO") return "auto-update";
  return rollout.createdBy ? rollout.createdBy.name || rollout.createdBy.email : "";
}

function tally(jobs: { state: JobState }[]) {
  const count = (state: JobState) => jobs.filter((job) => job.state === state).length;
  return {
    success: count("SUCCESS"),
    failed: count("FAILED"),
    skipped: count("SKIPPED"),
    cancelled: count("CANCELLED"),
  };
}

/** The boxes that failed and why, a few of them — the rest is on the page. */
function failures(jobs: LoadedRollout["jobs"], limit = 5): string {
  const failed = jobs.filter((job) => job.state === "FAILED");
  const lines = failed
    .slice(0, limit)
    .map((job) => `${job.device.name} — ${clamp(job.lastError ?? "no error recorded", 120)}`);
  if (failed.length > limit) lines.push(`… and ${failed.length - limit} more`);
  return lines.join("\n");
}

const rolloutPath = (id: string) => `/rollouts/${id}`;
const rolloutTag = (id: string) => `rollout:${id}`;

/**
 * A rollout was just created. Called once, from `createRollout`, after its
 * first recompute — so the status it reads is the one it actually starts in.
 */
export function announceRolloutStarted(rollout: {
  id: string;
  mode: RolloutMode;
  note: string | null;
  jobs: { state: JobState }[];
}): void {
  const event = startedEvent(rollout);
  if (!event) return;

  fire(event, async () => {
    const loaded = await loadRollout(rollout.id);
    if (!loaded) return null;

    const { skipped } = tally(loaded.jobs);
    const target = loaded.appVersion.appTarget;
    const window =
      loaded.mode === "AUTO" && target.windowStart && target.windowEnd
        ? `installs only between ${target.windowStart} and ${target.windowEnd}`
        : "";
    const waitingFor =
      loaded.status === "PENDING" && loaded.waitsFor
        ? `${loaded.waitsFor.appVersion.appTarget.displayName} ${loaded.waitsFor.appVersion.version} first`
        : "";

    return notice({
      icon: "🚀",
      title: `${rolloutKind(loaded)} started — ${rolloutSubject(loaded)}`,
      fields: [
        {
          name: "Boxes",
          value:
            plural(loaded.jobs.length - skipped, "box", "boxes") +
            " to update" +
            (skipped > 0 ? ` · ${skipped} already on it` : ""),
          inline: true,
        },
        {
          name: "Canary",
          value:
            loaded.canaryCount > 0
              ? `${loaded.canaryCount} first` +
                (loaded.soakMinutes > 0 ? `, then a ${loaded.soakMinutes} min soak` : "")
              : "",
          inline: true,
        },
        { name: "Waiting for", value: waitingFor, inline: true },
        { name: "Window", value: window, inline: true },
        { name: "Started by", value: startedBy(loaded), inline: true },
      ],
      path: rolloutPath(loaded.id),
      tag: rolloutTag(loaded.id),
      footer: "rollout",
      quiet: true,
    });
  });
}

/**
 * One message per build for a new machine whose boxes all fail the same join
 * install — ten containers coming up is ten rollouts, and one failure is the
 * news, not ten.
 */
const JOIN_FAILURE_QUIET_MS = 30 * 60 * 1000;
const joinFailureAnnounced = new Map<string, number>();

/**
 * A rollout just reached COMPLETED. Called by the winner of the status write
 * in `recomputeRollout`, so once per completion — a retry that completes it
 * again is a new outcome and is announced again.
 */
export function announceRolloutSettled(rollout: {
  id: string;
  appVersionId: string;
  note: string | null;
  jobs: { state: JobState }[];
}): void {
  const event = settledEvent(rollout);
  if (!event) return;

  fire(event, async () => {
    if (event === "joinInstallFailed") {
      const last = joinFailureAnnounced.get(rollout.appVersionId);
      if (last !== undefined && Date.now() - last < JOIN_FAILURE_QUIET_MS) return null;
      joinFailureAnnounced.set(rollout.appVersionId, Date.now());
    }

    const loaded = await loadRollout(rollout.id);
    if (!loaded) return null;
    const counts = tally(loaded.jobs);

    if (event === "joinInstallFailed") {
      const job = loaded.jobs.find((candidate) => candidate.state === "FAILED");
      return notice({
        level: "WARN",
        title: `${job?.device.name ?? "A new box"} could not install ${rolloutSubject(loaded)}`,
        fields: [
          { name: "Group", value: job?.device.group?.name ?? "", inline: true },
          { name: "Error", value: clamp(job?.lastError ?? "no error recorded", 300) },
          {
            name: "Next",
            value:
              "Retry it from the rollout page. Other boxes failing this build in the next 30 minutes are not announced separately.",
          },
        ],
        path: rolloutPath(loaded.id),
        tag: `join:${loaded.appVersionId}`,
        footer: "join install",
      });
    }

    const boxes = [
      `${counts.success} updated`,
      counts.failed > 0 ? `${counts.failed} failed` : "",
      counts.skipped > 0 ? `${counts.skipped} already on it` : "",
      counts.cancelled > 0 ? `${counts.cancelled} cancelled` : "",
    ]
      .filter(Boolean)
      .join(" · ");

    const failed = event === "rolloutFailed";
    return notice({
      level: failed ? "WARN" : "INFO",
      title: failed
        ? `${rolloutKind(loaded)} finished with failures — ${rolloutSubject(loaded)}`
        : `${rolloutKind(loaded)} finished — ${rolloutSubject(loaded)}`,
      fields: [
        { name: "Boxes", value: boxes, inline: true },
        {
          name: "Took",
          value: took(loaded.startedAt ?? loaded.createdAt, loaded.finishedAt),
          inline: true,
        },
        { name: "Started by", value: startedBy(loaded), inline: true },
        { name: "Failed", value: failed ? failures(loaded.jobs) : "" },
      ],
      path: rolloutPath(loaded.id),
      tag: rolloutTag(loaded.id),
      footer: "rollout",
      quiet: !failed,
    });
  });
}

/**
 * A canary failed and the rollout parked itself rather than take the build to
 * the rest of the fleet. Called once, on the CANARY → PAUSED write.
 */
export function announceRolloutPaused(rolloutId: string): void {
  fire("rolloutPaused", async () => {
    const loaded = await loadRollout(rolloutId);
    if (!loaded) return null;

    return notice({
      level: "WARN",
      icon: "⏸️",
      title: `Canary failed — ${rolloutSubject(loaded)} is paused`,
      fields: [
        { name: "Failed", value: failures(loaded.jobs.filter((job) => job.isCanary)) },
        {
          name: "Next",
          value:
            loaded.mode === "AUTO"
              ? "Nothing else gets the build until the rollout is resumed or cancelled, and auto-update for this app waits for it too."
              : "Nothing else gets the build until the rollout is resumed or cancelled.",
        },
        { name: "Started by", value: startedBy(loaded), inline: true },
      ],
      path: rolloutPath(loaded.id),
      tag: rolloutTag(loaded.id),
      footer: "rollout",
    });
  });
}

// ---------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------

/**
 * A poll pass created new builds for a target. One message for the newest,
 * and only if it is newer than everything already known — see `newestIfNews`.
 */
export function announceBuildsDiscovered(
  target: { id: string; displayName: string; autoUpdateEnabled: boolean },
  created: { id: string; version: string }[],
): void {
  if (created.length === 0) return;

  fire("buildDiscovered", async () => {
    const known = await prisma.appVersion.findMany({
      where: { appTargetId: target.id, id: { notIn: created.map((build) => build.id) } },
      select: { version: true },
    });
    const newest = newestIfNews(
      created.map((build) => build.version),
      known.map((build) => build.version),
    );
    if (!newest) return null;

    const row = await prisma.appVersion.findFirst({
      where: { id: { in: created.map((build) => build.id) }, version: newest },
      select: { approved: true, feed: { select: { name: true } } },
    });
    const older = new Set(created.map((build) => build.version));
    older.delete(newest);

    return notice({
      icon: "📦",
      title: `New build — ${target.displayName} ${newest}`,
      fields: [
        { name: "Source", value: row?.feed?.name ?? "", inline: true },
        {
          name: "Status",
          value: row?.approved
            ? target.autoUpdateEnabled
              ? "approved — auto-update will roll it out"
              : "approved"
            : "waiting for approval",
          inline: true,
        },
        { name: "Also new", value: older.size > 0 ? plural(older.size, "older build") : "" },
      ],
      path: "/versions",
      tag: `build:${target.id}`,
      footer: "builds",
      quiet: true,
    });
  });
}

/**
 * A build would not download or did not verify. Called from the one write
 * that marks it FAILED, and nothing retries a failed build on its own — the
 * poller only clears it when its URL moves — so this is once per attempt.
 */
export function announceBuildCacheFailed(
  build: { id: string; version: string; appTarget: { displayName: string } },
  error: string,
): void {
  fire("buildCacheFailed", async () => {
    const row = await prisma.appVersion.findUnique({
      where: { id: build.id },
      select: { feed: { select: { name: true } } },
    });
    return notice({
      level: "WARN",
      title: `Download failed — ${build.appTarget.displayName} ${build.version}`,
      fields: [
        { name: "Source", value: row?.feed?.name ?? "", inline: true },
        { name: "Error", value: clamp(error, 300) },
        {
          name: "Next",
          value: "Auto-update passes over a build that failed to download. Retry it from Versions.",
        },
      ],
      path: "/versions",
      tag: `cache:${build.id}`,
      footer: "builds",
    });
  });
}

/** Per source, how its recent passes went. Lost on restart, deliberately. */
const sourceStates = new Map<string, SourceState>();

/**
 * One poll pass of a source, success or not. Says something only when the
 * source has just started failing — two passes in a row — or has just
 * recovered from a failure that was announced.
 */
export function noteSourcePass(
  feed: { id: string; name: string },
  ok: boolean,
  error: string | null,
): void {
  const { state, say } = nextSourceState(sourceStates.get(feed.id), ok);
  sourceStates.set(feed.id, state);
  if (!say) return;

  fire("sourceFailing", () =>
    say === "failing"
      ? notice({
          level: "WARN",
          title: `Version source failing — ${feed.name}`,
          fields: [
            { name: "Error", value: clamp(error ?? "no error recorded", 300) },
            {
              name: "Effect",
              value:
                "Nothing new is found through it, so auto-update has nothing new from it to roll out.",
            },
          ],
          path: "/settings#sources",
          tag: `source:${feed.id}`,
          footer: "sources",
        })
      : notice({
          title: `Version source working again — ${feed.name}`,
          fields: [],
          summary: "The last poll read it without an error.",
          path: "/settings#sources",
          tag: `source:${feed.id}`,
          footer: "sources",
          quiet: true,
        }),
  );
}

// ---------------------------------------------------------------------------
// Machines
// ---------------------------------------------------------------------------

const hostPath = (deviceId: string | null) => (deviceId ? `/hosts/${deviceId}` : "/hosts");

/**
 * A provisioned machine dialled in and was claimed. Called from the write
 * that claimed it, so once per bootstrap.
 */
export function announceMachineReady(bootstrap: {
  name: string;
  deviceId: string;
  desiredInstances: number;
}): void {
  fire("machineReady", () =>
    notice({
      icon: "🖥️",
      title: `Machine set up — ${bootstrap.name}`,
      fields: [
        {
          name: "Containers",
          value:
            bootstrap.desiredInstances > 0
              ? `${plural(bootstrap.desiredInstances, "container")} starting`
              : "none yet — add some from its page",
        },
      ],
      path: hostPath(bootstrap.deviceId),
      tag: `machine:${bootstrap.deviceId}`,
      footer: "machines",
      quiet: true,
    }),
  );
}

type SetupFailure = {
  name: string;
  deviceId: string | null;
  error: string;
  /** The script step it stopped at, when it got as far as printing one. */
  step?: string | null;
  rerun?: boolean;
};

function setupFailedNotice(input: SetupFailure): Notice {
  return notice({
    level: "WARN",
    title: `${input.rerun ? "Machine setup re-run" : "Machine setup"} failed — ${input.name}`,
    fields: [
      { name: "Step", value: input.step ?? "", inline: true },
      { name: "Error", value: clamp(input.error, 300) },
      { name: "Next", value: "Setup is safe to run again: it skips what is already done." },
    ],
    path: hostPath(input.deviceId),
    tag: `machine:${input.deviceId ?? input.name}`,
    footer: "machines",
  });
}

/**
 * A machine's setup failed over SSH, or was left running by a hub that
 * restarted under it.
 */
export function announceMachineSetupFailed(input: SetupFailure): void {
  fire("machineSetupFailed", () => setupFailedNotice(input));
}

/** A re-run of a machine's setup reported back, either way. */
export function announceMachineRerun(
  deviceId: string,
  result: { ok: boolean; error?: string | null; steps: { name: string; ok: boolean }[] },
): void {
  const machineName = async () =>
    (await prisma.device.findUnique({ where: { id: deviceId }, select: { name: true } }))?.name ??
    "a machine";

  if (!result.ok) {
    fire("machineSetupFailed", async () =>
      setupFailedNotice({
        name: await machineName(),
        deviceId,
        error: result.error ?? "the bootstrap failed",
        step: result.steps.find((step) => !step.ok)?.name ?? null,
        rerun: true,
      }),
    );
    return;
  }

  fire("machineReady", async () =>
    notice({
      icon: "🖥️",
      title: `Machine setup re-run finished — ${await machineName()}`,
      fields: [],
      summary: "Every step of the setup reported done.",
      path: hostPath(deviceId),
      tag: `machine:${deviceId}`,
      footer: "machines",
      quiet: true,
    }),
  );
}

/**
 * A machine could not apply its containers. Each converge the hub dispatches
 * is answered once and nothing re-sends it on its own, so this is once per
 * attempt.
 */
export function announceConvergeFailed(deviceId: string, error: string): void {
  fire("convergeFailed", async () => {
    const device = await prisma.device.findUnique({
      where: { id: deviceId },
      select: { name: true },
    });
    return notice({
      level: "WARN",
      title: `${device?.name ?? "A machine"} could not apply its containers`,
      fields: [{ name: "Next", value: "Docker's own output is on the machine's page." }],
      detail: error,
      path: hostPath(deviceId),
      tag: `converge:${deviceId}`,
      footer: "machines",
    });
  });
}

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------

/**
 * Agent versions whose failure has already been announced.
 *
 * Per hub process, which is exact rather than lazy: the agent release only
 * changes when the hub restarts. And it is what stops this being a message a
 * minute per box — a box that reports a failure is released, and the sweep
 * offers it the same update again a minute later.
 */
const agentFailuresAnnounced = new Set<string>();

/** A box reported that it could not swap its agent binary. */
export function announceAgentUpdateFailed(
  deviceId: string,
  version: string,
  error: string | null,
): void {
  fire("agentUpdateFailed", async () => {
    if (agentFailuresAnnounced.has(version)) return null;
    agentFailuresAnnounced.add(version);

    const device = await prisma.device.findUnique({
      where: { id: deviceId },
      select: { name: true },
    });
    return notice({
      level: "WARN",
      title: `Agent update to ${version} failed — ${device?.name ?? "a box"}`,
      fields: [
        {
          name: "Error",
          value: clamp(error ?? "the agent reported a failure with no detail", 300),
        },
        {
          name: "Next",
          value:
            "The box keeps running its old agent and is offered the update again. Other boxes failing this version are not announced until the hub restarts.",
        },
      ],
      path: `/devices/${deviceId}`,
      tag: `agent:${version}`,
      footer: "agent",
    });
  });
}
