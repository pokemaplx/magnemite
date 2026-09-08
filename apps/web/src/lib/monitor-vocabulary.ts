import type { MonitorChannel } from "@magnemite/db";
import {
  AppWindow,
  Ban,
  Bell,
  CornerDownLeft,
  Gauge,
  HeartPulse,
  type LucideIcon,
  Power,
  Radar,
  Radio,
  RadioTower,
  RotateCcw,
  ServerOff,
  Terminal,
  Timer,
  Trash2,
  Unplug,
  WifiOff,
  Zap,
} from "lucide-react";

/**
 * The words the monitoring UI uses, in one place.
 *
 * Both screens name the same seven signals and nine actions — the rules editor
 * in the present tense ("Restart the app") and the activity feed in the past
 * ("Restarted the app") — and they had drifted into two hand-kept lists. A
 * signal added to one and forgotten in the other shows up as a raw enum in
 * front of somebody trying to read an incident, so they live here together.
 *
 * The metadata beside each label is what lets the form ask for only what a
 * signal actually needs: a probe is the whole rule for a log check and is never
 * read for an unreachable box, and a form that offers both equally is a form
 * that has to be learned rather than read.
 */

export type ProbeNeed = "required" | "optional" | "none";

export type SignalMeta = {
  value: string;
  label: string;
  /** One line under the picker, in the terms an operator would use. */
  hint: string;
  icon: LucideIcon;
  /** The signal is about one app, and the rule is rejected without it. */
  needsPackage: boolean;
  /** Whether a probe on the box is what answers this. */
  probe: ProbeNeed;
  /**
   * Only a box on an agent new enough to look at itself can report it — which
   * is why an old fleet can have a rule that is on and never fires.
   */
  needsAgent: boolean;
};

export const SIGNALS: SignalMeta[] = [
  {
    value: "SERVICE_DOWN",
    label: "Service is down",
    hint: "The app has no process on the box. A probe makes it certain — without one, a box too old to list its processes reads as unknown rather than dead.",
    icon: ServerOff,
    needsPackage: true,
    probe: "optional",
    // Both ways of answering it — the probe and the process list — are things
    // the box reports, so an agent too old to look cannot answer it either.
    needsAgent: true,
  },
  {
    value: "APP_NOT_FOREGROUND",
    label: "App is not in focus",
    hint: "Something else is on the screen — usually the launcher, which is a box sitting idle rather than working.",
    icon: AppWindow,
    needsPackage: true,
    probe: "none",
    needsAgent: true,
  },
  {
    value: "APP_ANR",
    label: "App is not responding",
    hint: "Android has put its “isn’t responding” dialog up over the app.",
    icon: Ban,
    needsPackage: true,
    probe: "none",
    needsAgent: true,
  },
  {
    value: "HEALTH_CHECK_FAILED",
    label: "Health check is failing",
    hint: "A probe you write says the app is unhealthy — a log line, a command, or an endpoint that stopped answering.",
    icon: HeartPulse,
    needsPackage: false,
    probe: "required",
    needsAgent: true,
  },
  {
    value: "LOOP_STALLED",
    label: "Loop has stalled",
    hint: "The app is up and no work is getting done. Read out of a log on the box.",
    icon: Timer,
    needsPackage: false,
    probe: "required",
    needsAgent: true,
  },
  {
    value: "AGENT_OFFLINE",
    label: "Box is unreachable",
    hint: "The box stopped answering the hub for longer than the offline timeout. Nothing can be run on it, so the ladder can only tell you — raise the threshold to wait longer first.",
    icon: WifiOff,
    needsPackage: false,
    probe: "none",
    needsAgent: false,
  },
  {
    value: "ROTOM_DISCONNECTED",
    label: "Rotom lost the box",
    hint: "Rotom no longer has the scanner connected, or has not heard from it inside the stale delay. A box disabled in Rotom on purpose is left alone.",
    icon: Radio,
    needsPackage: false,
    probe: "none",
    needsAgent: false,
  },
  {
    value: "ROTOM_NOT_SCANNING",
    label: "Rotom has the box but no workers",
    hint: "The scanner is connected and Rotom has nothing allocated on it. A fleet with more boxes than accounts has idle spares on purpose — scope this to a group, or raise the threshold.",
    icon: RadioTower,
    needsPackage: false,
    probe: "none",
    needsAgent: false,
  },
  {
    value: "ROTOM_IDLE",
    label: "Scanner is allocated and doing nothing",
    hint: "Rotom is holding a worker open on the box and no requests are coming through it. Silent unless Rotom measures request rates, which it only does in requests mode, or proxy mode with inspect.",
    icon: Gauge,
    needsPackage: false,
    probe: "none",
    needsAgent: false,
  },
];

export const SIGNAL_OPTIONS = SIGNALS.map(({ value, label }) => ({ value, label }));

const SIGNAL_BY_VALUE = new Map(SIGNALS.map((signal) => [signal.value, signal]));

/** Never null: an enum this UI has not learned yet renders as itself. */
export function signalMeta(value: string): SignalMeta {
  return (
    SIGNAL_BY_VALUE.get(value) ?? {
      value,
      label: value,
      hint: "",
      icon: HeartPulse,
      needsPackage: false,
      probe: "optional",
      needsAgent: false,
    }
  );
}

export function signalLabel(value: string): string {
  return signalMeta(value).label;
}

export type ActionMeta = {
  value: string;
  /** What the rule will do. */
  label: string;
  /** What it did, for the activity feed. */
  past: string;
  icon: LucideIcon;
  /** Expensive and disruptive — the bottom of a ladder, never the top of one. */
  hard: boolean;
  /** The action is the command, so the ladder row has to ask for one. */
  needsCommand: boolean;
};

export const ACTIONS: ActionMeta[] = [
  {
    value: "NOTIFY_ONLY",
    label: "Only tell me",
    past: "Told you",
    icon: Bell,
    hard: false,
    needsCommand: false,
  },
  {
    value: "RESTART_APP",
    label: "Restart the app",
    past: "Restarted the app",
    icon: RotateCcw,
    hard: false,
    needsCommand: false,
  },
  {
    value: "KILL_APP",
    label: "Kill the app",
    past: "Killed the app",
    icon: Ban,
    hard: false,
    needsCommand: false,
  },
  {
    value: "CLEAR_CACHE_RESTART",
    label: "Clear the cache and restart",
    past: "Cleared the cache and restarted",
    icon: Trash2,
    hard: false,
    needsCommand: false,
  },
  {
    value: "SEND_KEYEVENT",
    label: "Send ENTER",
    past: "Sent ENTER",
    icon: CornerDownLeft,
    hard: false,
    needsCommand: false,
  },
  {
    value: "START_SERVICE",
    label: "Start the service",
    past: "Started the service",
    icon: Zap,
    hard: false,
    needsCommand: false,
  },
  {
    value: "SHELL",
    label: "Run a command",
    past: "Ran a command",
    icon: Terminal,
    hard: false,
    needsCommand: true,
  },
  {
    value: "REBOOT",
    label: "Reboot the box",
    past: "Rebooted the box",
    icon: Power,
    hard: true,
    needsCommand: false,
  },
  {
    value: "ROTOM_RESTART",
    label: "Restart the scanner in Rotom",
    past: "Restarted the scanner in Rotom",
    // The same icon the button on the scanner page uses — one action, one mark.
    icon: Radar,
    hard: false,
    needsCommand: false,
  },
  {
    value: "ROTOM_DISCONNECT",
    label: "Drop the scanner's connection in Rotom",
    past: "Dropped the scanner's connection in Rotom",
    icon: Unplug,
    hard: false,
    needsCommand: false,
  },
  {
    value: "ROTOM_REBOOT",
    label: "Reboot the box through Rotom",
    past: "Rebooted the box through Rotom",
    icon: Power,
    // Counts against the daily reboot ceiling exactly like the agent-side one:
    // a different socket, the same boot cycle.
    hard: true,
    needsCommand: false,
  },
];

export const ACTION_OPTIONS = ACTIONS.map(({ value, label }) => ({ value, label }));

const ACTION_BY_VALUE = new Map(ACTIONS.map((action) => [action.value, action]));

export function actionMeta(value: string): ActionMeta {
  return (
    ACTION_BY_VALUE.get(value) ?? {
      value,
      label: value,
      past: value,
      icon: Zap,
      hard: false,
      needsCommand: false,
    }
  );
}

export function actionLabel(value: string): string {
  return actionMeta(value).label;
}

export function actionPastLabel(value: string): string {
  return actionMeta(value).past;
}

export const LEVEL_OPTIONS = [
  { value: "INFO", label: "Info" },
  { value: "WARN", label: "Warning" },
  { value: "CRITICAL", label: "Critical" },
];

/**
 * The notification channels, for the browser.
 *
 * `@magnemite/db` owns the ids — it is what reads and writes the column — but
 * importing the *values* from there drags Prisma and `node:crypto` into a
 * client bundle, which fails the build with an unhandled `node:` scheme
 * rather than anything that names the real problem. So the ids are restated
 * here and tied back with two type-level checks that cost nothing at runtime:
 * `satisfies` rejects an id that is not a channel, and the `Record` below
 * rejects a channel that is missing from it. A channel added or renamed in the
 * database package fails to compile here rather than quietly disappearing from
 * the picker.
 */
export const CHANNEL_IDS = [
  "discord",
  "ntfy",
  "webPush",
] as const satisfies readonly MonitorChannel[];

export const CHANNEL_LABELS: Record<MonitorChannel, string> = {
  discord: "Discord",
  ntfy: "ntfy",
  webPush: "Web push",
};

export const PROBE_OPTIONS = [
  { value: "none", label: "No probe" },
  { value: "shell", label: "Shell command" },
  { value: "logMatch", label: "Pattern in a log" },
  { value: "http", label: "HTTP endpoint" },
];

/** The kind to start on when a signal cannot be answered without a probe. */
export function defaultProbeKind(signal: string): string {
  return signal === "LOOP_STALLED" || signal === "HEALTH_CHECK_FAILED" ? "logMatch" : "shell";
}

export function labelFor(options: { value: string; label: string }[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}
