import type { JobState } from "@magnemite/db";

/**
 * How far a new Redroid instance has got, from somebody asking for it to the
 * box inside it having its apps.
 *
 * A scale-up used to read as one badge going unknown, absent, running, with
 * nothing in between to say anything was happening -- and the longest stretch,
 * Android booting, said nothing at all. This puts a name on each stretch, from
 * what the dashboard already has: the instance row, the machine's converge, the
 * box's socket and its join installs.
 *
 * Pure and free of the database client, so a client component can import its
 * types without dragging Prisma into the browser bundle.
 */

/**
 * How long after it was asked for an instance that is still not up reads as
 * setting up. Past it the usual badge takes over, because what it says --
 * absent, not enrolled -- is then a fault rather than a stage.
 */
export const SETUP_WINDOW_MS = 30 * 60 * 1000;

/** The hub's `CONVERGE_STALE_MS`: past it, `convergingSince` is a lost result. */
const CONVERGE_STALE_MS = 30 * 60 * 1000;

export type SetupInstall = {
  /** "Pokémon GO 0.433.0". */
  app: string;
  state: JobState;
  progress: number;
  /** ISO. Held until then, while the box settles after booting. */
  heldUntil: string | null;
  /** ISO. */
  queuedAt: string;
};

export type SetupFacts = {
  /** ISO, or null on a row from before the column existed. */
  requestedAt: string | null;
  containerState: string | null;
  /** The box inside has its socket up -- which is Android booted, and then some. */
  boxOnline: boolean;
  /** Its join installs, oldest first. */
  installs: SetupInstall[];
  machine: {
    name: string;
    online: boolean;
    /** ISO, or null while no converge is running. */
    convergingSince: string | null;
    lastError: string | null;
    /** ISO. */
    lastErrorAt: string | null;
  };
};

export type SetupView = {
  /** Short enough for a table cell. */
  label: string;
  /** The longer version, for the tooltip. */
  detail: string;
  percent: number;
  tone: "primary" | "warning" | "danger";
  /** ISO. What the elapsed clock counts from: when it was asked for. */
  since: string;
};

/** docker states that are a fault, not a stage. The usual red badge says those. */
const FAULTS = new Set(["exited", "dead", "restarting", "paused", "removing"]);

const DONE: JobState[] = ["SUCCESS", "SKIPPED"];
const OVER: JobState[] = ["SUCCESS", "SKIPPED", "FAILED", "CANCELLED"];
const WORKING: Partial<Record<JobState, string>> = {
  DISPATCHED: "starting",
  DOWNLOADING: "downloading",
  EXTRACTING: "unpacking",
  INSTALLING: "installing",
  VERIFYING: "checking the install",
};

/**
 * What to show for an instance, or null when it is not setting up -- set up
 * long ago, finished, or broken in a way the usual badge already says.
 */
export function setupView(facts: SetupFacts, now = Date.now()): SetupView | null {
  if (!facts.requestedAt) return null;
  const since = facts.requestedAt;
  const requested = Date.parse(since);
  const installs = facts.installs.filter((install) => Date.parse(install.queuedAt) >= requested);

  // The box is up. What is left is what its group installs on joining, and
  // that has its own clock -- a game over a thin uplink can outlast the window.
  if (facts.boxOnline) {
    const pending = installs.filter((install) => !OVER.includes(install.state));
    if (pending.length === 0) return null;

    const total = installs.length;
    const done = installs.filter((install) => DONE.includes(install.state)).length;
    const failed = installs.find((install) => install.state === "FAILED");
    const current = pending[0]!;
    const working = WORKING[current.state];
    const share = (done + (working ? current.progress / 100 : 0)) / total;
    const percent = 55 + 45 * share;

    if (failed) {
      return {
        label: `${failed.app} failed`,
        detail: `${current.app} waits for it. Retry it on Rollouts, or start ${current.app} anyway from its rollout.`,
        percent,
        tone: "danger",
        since,
      };
    }
    if (working) {
      return {
        label: `Installing ${current.app}`,
        detail: `${working}, ${current.progress}% — ${done} of ${total} installed`,
        percent,
        tone: "primary",
        since,
      };
    }
    const held = current.heldUntil !== null && Date.parse(current.heldUntil) > now;
    return {
      label: held ? `Settling, then ${current.app}` : `${current.app} next`,
      detail: held
        ? "A box that has just booted is left to settle before its group's installs start (Settings → Tuning)."
        : "Waiting for a free install slot, or for the install before it.",
      percent,
      tone: "primary",
      since,
    };
  }

  // Not up yet. Past the window that is no longer a stage, and the usual badge
  // -- absent, not enrolled -- says what is wrong.
  if (now - requested > SETUP_WINDOW_MS) return null;
  const state = facts.containerState;
  if (state !== null && FAULTS.has(state)) return null;

  const machine = facts.machine;
  if (!machine.online) {
    return {
      label: "Waiting for the machine",
      detail: `${machine.name} is offline. It creates this container when it reconnects.`,
      percent: 5,
      tone: "warning",
      since,
    };
  }

  const failedAt = machine.lastErrorAt ? Date.parse(machine.lastErrorAt) : null;
  if (state !== "running" && machine.lastError && failedAt !== null && failedAt >= requested) {
    return {
      label: "Converge failed",
      detail: machine.lastError.split("\n")[0] ?? machine.lastError,
      percent: 10,
      tone: "danger",
      since,
    };
  }

  if (state === null || state === "absent") {
    const converging =
      machine.convergingSince !== null &&
      now - Date.parse(machine.convergingSince) < CONVERGE_STALE_MS;
    return {
      label: "Creating the container",
      detail: converging
        ? `docker compose is bringing it up on ${machine.name}.`
        : `Waiting for ${machine.name} to report it — the machine reports its containers every heartbeat.`,
      percent: 15,
      tone: "primary",
      since,
    };
  }
  if (state === "created") {
    return {
      label: "Starting the container",
      detail: "Created, and being started.",
      percent: 25,
      tone: "primary",
      since,
    };
  }
  if (state === "running") {
    return {
      label: "Booting Android",
      detail: "The box dials in once Android has booted — usually a minute or two.",
      percent: 40,
      tone: "primary",
      since,
    };
  }
  return null;
}

/** `45s`, `2m 14s`, `1h 03m`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
