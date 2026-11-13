import type { DeviceKind, NotifyChannel } from "@magnemite/db";
import {
  AppWindow,
  Ban,
  Bell,
  Container,
  CornerDownLeft,
  Gauge,
  HardDrive,
  HeartPulse,
  type LucideIcon,
  MemoryStick,
  Power,
  Radar,
  Radio,
  RadioTower,
  RotateCcw,
  ServerCrash,
  ServerOff,
  Terminal,
  Thermometer,
  Timer,
  Trash2,
  Unplug,
  WifiOff,
  Zap,
  PlugZap,
} from "lucide-react";

/**
 * The words the monitoring UI uses, in one place.
 *
 * Both screens name the same signals and actions — the rules editor in the
 * present tense ("Restart the app") and the activity feed in the past
 * ("Restarted the app") — and they had drifted into two hand-kept lists. A
 * signal added to one and forgotten in the other shows up as a raw enum in
 * front of somebody trying to read an incident, so they live here together.
 *
 * The metadata beside each label is what lets the form ask for only what a
 * signal actually needs: a probe is the whole rule for a log check and is never
 * read for an unreachable box, and a form that offers both equally is a form
 * that has to be learned rather than read.
 *
 * `kinds` is the same idea pointed at the fleet rather than at the form. A box
 * and the machine that hosts it answer different questions — a VPS has no app
 * to be in focus, a box has no docker daemon — and the hub filters a rule on
 * that pair before it reads a single reading. A signal offered under the wrong
 * one is a rule somebody can save, enable, and watch do nothing.
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
  /**
   * The machines this signal can fire on, and not derivable from anything
   * else: the hub's `rulesFor` drops a rule whose `appliesTo` does not match
   * the machine in front of it, so a signal offered under the wrong scope is a
   * rule that is enabled and unreachable. Spelled out on every entry rather
   * than defaulted, so a signal added here has to say what it watches.
   */
  kinds: DeviceKind[];
  /**
   * The percentage floor the hub compares a reading against, for the two
   * signals that have one — null for everything else.
   *
   * It carries its own words because a floor on memory and a floor on disk are
   * the same number about different consequences. And it is not optional in
   * practice: the hub's `underFloor` reads *unknown* when a rule has no floor
   * configured, unknown neither counts nor resets, so a rule saved without one
   * looks complete and never fires.
   */
  floor: { label: string; hint: string } | null;
  /**
   * The absolute ceiling the hub compares a reading against, for the one
   * signal whose reading is not a share of anything.
   *
   * Degrees are degrees: 85 means the same thing on a 2 GB TV box and an 8 GB
   * container, where "15% free" does not. Separate from `floor` rather than a
   * sign on it, because the two read in opposite directions and a single field
   * that sometimes meant "under" and sometimes "over" is the kind of control
   * that gets set backwards once and then rebooted a fleet.
   *
   * `unit` is only a suffix in the form. Null on every other signal, like the
   * floor, so a signal added here has to say which kind of number it wants.
   */
  ceiling: { label: string; hint: string; unit: string } | null;
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
    kinds: ["BOX"],
    floor: null,
    ceiling: null,
  },
  {
    value: "APP_NOT_FOREGROUND",
    label: "App is not in focus",
    hint: "Something else is on the screen — usually the launcher, which is a box sitting idle rather than working.",
    icon: AppWindow,
    needsPackage: true,
    probe: "none",
    needsAgent: true,
    kinds: ["BOX"],
    floor: null,
    ceiling: null,
  },
  {
    value: "APP_ANR",
    label: "App is not responding",
    hint: "Android has put its “isn’t responding” dialog up over the app.",
    icon: Ban,
    needsPackage: true,
    probe: "none",
    needsAgent: true,
    kinds: ["BOX"],
    floor: null,
    ceiling: null,
  },
  {
    value: "HEALTH_CHECK_FAILED",
    label: "Health check is failing",
    hint: "A probe you write says the app is unhealthy — a log line, a command, or an endpoint that stopped answering.",
    icon: HeartPulse,
    needsPackage: false,
    probe: "required",
    needsAgent: true,
    kinds: ["BOX"],
    floor: null,
    ceiling: null,
  },
  {
    value: "LOOP_STALLED",
    label: "Loop has stalled",
    hint: "The app is up and no work is getting done. Read out of a log on the box.",
    icon: Timer,
    needsPackage: false,
    probe: "required",
    needsAgent: true,
    kinds: ["BOX"],
    floor: null,
    ceiling: null,
  },
  {
    value: "AGENT_OFFLINE",
    // Deliberately not "Box is unreachable": this is the one signal a machine
    // can carry too, and a machine rule labelled with the wrong noun is a rule
    // somebody has to translate every time they read it.
    label: "Stopped answering the hub",
    hint: "Nothing has been heard from it for longer than the offline timeout. Nothing can be run on it either, so the ladder can only tell you — raise the threshold to wait longer first.",
    icon: WifiOff,
    needsPackage: false,
    probe: "none",
    needsAgent: false,
    // The one signal that means the same thing on both. A machine dials out,
    // heartbeats and goes quiet exactly like a box does, and the offline sweep
    // that notices never asked which it was.
    kinds: ["BOX", "HOST"],
    floor: null,
    ceiling: null,
  },
  {
    value: "AGENT_STALLED",
    label: "Connected but silent",
    hint: "The socket is open and the heartbeats stopped — the box is reachable and its agent is wedged. Unlike “Stopped answering the hub”, a restart or a reboot can actually be sent, so a ladder here will land.",
    icon: PlugZap,
    needsPackage: false,
    probe: "none",
    needsAgent: false,
    // Same reasoning as AGENT_OFFLINE: a machine dials out and goes quiet the
    // same way a box does, and the sweep that notices never asked which.
    kinds: ["BOX", "HOST"],
    floor: null,
    ceiling: null,
  },
  {
    value: "ROTOM_DISCONNECTED",
    label: "Rotom lost the box",
    hint: "Rotom no longer has the scanner connected, or has not heard from it inside the stale delay. A box disabled in Rotom on purpose is left alone.",
    icon: Radio,
    needsPackage: false,
    probe: "none",
    needsAgent: false,
    kinds: ["BOX"],
    floor: null,
    ceiling: null,
  },
  {
    value: "ROTOM_NOT_SCANNING",
    label: "Rotom has the box but no workers",
    hint: "The scanner is connected and Rotom has nothing allocated on it. A fleet with more boxes than accounts has idle spares on purpose — scope this to a group, or raise the threshold.",
    icon: RadioTower,
    needsPackage: false,
    probe: "none",
    needsAgent: false,
    kinds: ["BOX"],
    floor: null,
    ceiling: null,
  },
  {
    value: "ROTOM_IDLE",
    label: "Scanner is allocated and doing nothing",
    hint: "Rotom is holding a worker open on the box and no requests are coming through it. Silent unless Rotom measures request rates, which it only does in requests mode, or proxy mode with inspect.",
    icon: Gauge,
    needsPackage: false,
    probe: "none",
    needsAgent: false,
    kinds: ["BOX"],
    floor: null,
    ceiling: null,
  },

  // --- machines ------------------------------------------------------------
  // All four are answered by the hub out of what the machine reports on every
  // heartbeat, so none of them takes a probe and none of them waits on an
  // agent new enough to look: the host agent is the new one by definition.

  {
    value: "HOST_DOCKER_DOWN",
    label: "Docker is down",
    hint: "The machine is answering and its docker daemon is not, so every box on it is down at once and none of them can be started. Nothing inside the machine can fix that, so the ladder can only tell you.",
    icon: ServerCrash,
    needsPackage: false,
    probe: "none",
    needsAgent: false,
    kinds: ["HOST"],
    floor: null,
    ceiling: null,
  },
  {
    value: "DEVICE_MEMORY_LOW",
    label: "Box is low on memory",
    hint: "The box is running out of memory, which is where a scanner starts being killed off and nothing says why. Read off the heartbeat it already sends — no probe, and it works on every box in the fleet.",
    icon: MemoryStick,
    // Pogo, or whatever the ladder should restart. The signal is about the box
    // and the actions are not: a rule that restarts an app has to know which.
    needsPackage: true,
    probe: "none",
    // The readings predate monitoring, which is the nice part: an agent too
    // old to run a probe still reports its memory.
    needsAgent: false,
    kinds: ["BOX"],
    floor: {
      label: "Alert under",
      hint: "Available memory as a share of the box's total. A container reports its cgroup's figure, so ten boxes on one machine each report their own — unless the container has no memory limit set, in which case it reports the machine's and this rule can never fire.",
    },
    ceiling: null,
  },
  {
    value: "DEVICE_STORAGE_LOW",
    label: "Box is low on disk",
    hint: "/data is filling up. Worth catching before a rollout does: an install refuses on low space, so the job fails instead of the box quietly clearing a cache first.",
    icon: HardDrive,
    needsPackage: true,
    probe: "none",
    needsAgent: false,
    kinds: ["BOX"],
    floor: {
      label: "Alert under",
      hint: "Free space on /data as a share of its total. A bundle of splits is about 170 MB, so leave room for one plus what it unpacks to.",
    },
    ceiling: null,
  },
  {
    value: "DEVICE_TEMP_HIGH",
    label: "Box is running hot",
    hint: "The SoC is over its ceiling, which on this hardware means it is throttling — still scanning, slowly. The failure it gets ahead of is a stalled loop nobody can explain.",
    icon: Thermometer,
    // There is no app to restart, because no action cools a box down.
    needsPackage: false,
    probe: "none",
    needsAgent: false,
    kinds: ["BOX"],
    floor: null,
    ceiling: {
      label: "Alert over",
      hint: "Degrees Celsius off the box's own thermal zones. A box whose ROM exposes no sensor reads as unknown rather than cold, so this rule simply never fires on one — which is most TV hardware.",
      unit: "°C",
    },
  },
  {
    value: "HOST_MEMORY_LOW",
    label: "Machine is low on memory",
    hint: "Memory and swap together are running out. The OOM killer takes whichever box it likes rather than the one that caused it, which is why this is worth hearing before it happens.",
    icon: MemoryStick,
    needsPackage: false,
    probe: "none",
    needsAgent: false,
    kinds: ["HOST"],
    floor: {
      label: "Alert under",
      // Swap counts as headroom, because on these machines it is exactly what
      // stands between a stack of Androids and the OOM killer. The hub adds
      // both pairs together before it compares.
      hint: "Free memory and free swap together, as a share of the machine's total. 10% is roughly one more box's worth of headroom.",
    },
    ceiling: null,
  },
  {
    value: "HOST_DISK_LOW",
    label: "Machine is low on disk",
    hint: "The filesystem docker keeps its images and volumes on is filling up. A full disk does not announce itself — it fails the next image pull, and wedges the containers already running.",
    icon: HardDrive,
    needsPackage: false,
    probe: "none",
    needsAgent: false,
    kinds: ["HOST"],
    floor: {
      label: "Alert under",
      hint: "Free space as a share of the filesystem's total. Leave room for one more image: a Redroid layer is a couple of gigabytes.",
    },
    ceiling: null,
  },
  {
    value: "REDROID_INSTANCE_DOWN",
    label: "A box on the machine is not running",
    hint: "A container the machine is meant to be running is stopped or wedged. Restarting that one container is the smallest thing that fixes it — the machine is left alone, because restarting it takes every other box on it down too.",
    icon: Container,
    needsPackage: false,
    probe: "none",
    needsAgent: false,
    kinds: ["HOST"],
    floor: null,
    ceiling: null,
  },
];

/**
 * Boxes, or the machines that host them.
 *
 * A `Record` rather than a list so that a third `DeviceKind` fails to compile
 * here instead of quietly becoming a scope with no word for it — the same
 * check `CHANNEL_LABELS` makes further down for the channels.
 */
export const SCOPE_LABELS: Record<DeviceKind, string> = {
  BOX: "Boxes",
  HOST: "Machines",
};

export const SCOPE_OPTIONS = (Object.keys(SCOPE_LABELS) as DeviceKind[]).map((kind) => ({
  value: kind,
  label: SCOPE_LABELS[kind],
}));

/** Every signal, whatever it watches. The pickers want `signalsFor` instead. */
export const SIGNAL_OPTIONS = SIGNALS.map(({ value, label }) => ({ value, label }));

/**
 * The signals that can fire on one kind of machine.
 *
 * Not cosmetic filtering: `rulesFor` in the hub drops a rule whose `appliesTo`
 * does not match the machine before it reads anything, so a box rule saved
 * against a machine sits in the list switched on, costs nothing, and reports
 * nothing. The picker is the only place that can stop it being made.
 */
export function signalsFor(kind: DeviceKind): { value: string; label: string }[] {
  return SIGNALS.filter((signal) => signal.kinds.includes(kind)).map(({ value, label }) => ({
    value,
    label,
  }));
}

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
      // Both, so an unknown signal is never hidden from the scope its rule is
      // already in. The list is for narrowing a choice, not for hiding a rule
      // that exists.
      kinds: ["BOX", "HOST"],
      floor: null,
      ceiling: null,
    }
  );
}

/**
 * The one scope a signal can live in, or null when it fits both.
 *
 * What the dialog opens an existing rule on when the row it was handed does
 * not carry `appliesTo`. Every signal but `AGENT_OFFLINE` answers this.
 */
export function scopeForSignal(value: string): DeviceKind | null {
  const { kinds } = signalMeta(value);
  return kinds.length === 1 ? (kinds[0] ?? null) : null;
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
  /**
   * The machines that can be told to do it. Most of these are an `am` or `pm`
   * command and mean nothing on a VPS; a rung a machine cannot run comes back
   * as "the rule has no command to run" at the one moment it was needed.
   */
  kinds: DeviceKind[];
};

export const ACTIONS: ActionMeta[] = [
  {
    value: "NOTIFY_ONLY",
    label: "Only tell me",
    past: "Told you",
    icon: Bell,
    hard: false,
    needsCommand: false,
    kinds: ["BOX", "HOST"],
  },
  {
    value: "RESTART_APP",
    label: "Restart the app",
    past: "Restarted the app",
    icon: RotateCcw,
    hard: false,
    needsCommand: false,
    kinds: ["BOX"],
  },
  {
    value: "KILL_APP",
    label: "Kill the app",
    past: "Killed the app",
    icon: Ban,
    hard: false,
    needsCommand: false,
    kinds: ["BOX"],
  },
  {
    value: "CLEAR_CACHE_RESTART",
    label: "Clear the cache and restart",
    past: "Cleared the cache and restarted",
    icon: Trash2,
    hard: false,
    needsCommand: false,
    kinds: ["BOX"],
  },
  {
    value: "SEND_KEYEVENT",
    label: "Send ENTER",
    past: "Sent ENTER",
    icon: CornerDownLeft,
    hard: false,
    needsCommand: false,
    kinds: ["BOX"],
  },
  {
    value: "START_SERVICE",
    label: "Start the service",
    past: "Started the service",
    icon: Zap,
    hard: false,
    needsCommand: false,
    kinds: ["BOX"],
  },
  {
    value: "SHELL",
    label: "Run a command",
    past: "Ran a command",
    icon: Terminal,
    hard: false,
    needsCommand: true,
    // A machine takes `exec` like any box does, so this one travels.
    kinds: ["BOX", "HOST"],
  },
  {
    value: "REBOOT",
    label: "Reboot the box",
    past: "Rebooted the box",
    icon: Power,
    hard: true,
    needsCommand: false,
    // Boxes only, deliberately: on a machine this would mean rebooting the VPS
    // and taking every box on it down for one box's fault. `MonitorAction` has
    // no spelling for that, and `RESTART_INSTANCE` is what it has instead.
    kinds: ["BOX"],
  },
  {
    value: "ROTOM_RESTART",
    label: "Restart the scanner in Rotom",
    past: "Restarted the scanner in Rotom",
    // The same icon the button on the scanner page uses — one action, one mark.
    icon: Radar,
    hard: false,
    needsCommand: false,
    kinds: ["BOX"],
  },
  {
    value: "ROTOM_DISCONNECT",
    label: "Drop the scanner's connection in Rotom",
    past: "Dropped the scanner's connection in Rotom",
    icon: Unplug,
    hard: false,
    needsCommand: false,
    kinds: ["BOX"],
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
    kinds: ["BOX"],
  },
  {
    value: "RESTART_INSTANCE",
    label: "Restart the box's container",
    past: "Restarted the box's container",
    // The same mark as "Restart the app", because it is the same move one
    // level out: the smallest restart that fixes the thing that is wedged.
    icon: RotateCcw,
    // Expensive even though it is the gentle option here. The container *is*
    // the box, so restarting it cold-boots that Android — every app on it
    // comes back from nothing.
    hard: true,
    needsCommand: false,
    kinds: ["HOST"],
  },
];

/** Every action. The ladder wants `actionsFor` instead. */
export const ACTION_OPTIONS = ACTIONS.map(({ value, label }) => ({ value, label }));

export function actionsFor(kind: DeviceKind): { value: string; label: string }[] {
  return ACTIONS.filter((action) => action.kinds.includes(kind)).map(({ value, label }) => ({
    value,
    label,
  }));
}

/**
 * What a new rung starts on: the hardest thing that kind can be told to do,
 * because a rung is added to the bottom of a ladder and the bottom is where
 * the expensive answer goes. Not derived from `hard`, which two box actions
 * carry — rebooting through Rotom is the fallback for a box the agent has
 * lost, not the thing to reach for first.
 */
export const LADDER_LAST_RESORT: Record<DeviceKind, string> = {
  BOX: "REBOOT",
  HOST: "RESTART_INSTANCE",
};

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
      // Both, for the same reason `signalMeta` says both: this renders a rung
      // that already exists, and hiding it would hide what a rule does.
      kinds: ["BOX", "HOST"],
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
] as const satisfies readonly NotifyChannel[];

export const CHANNEL_LABELS: Record<NotifyChannel, string> = {
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
