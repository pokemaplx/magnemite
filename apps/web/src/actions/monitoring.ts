"use server";

import { revalidatePath } from "next/cache";
import {
  type DeviceKind,
  NOTIFY_CHANNELS,
  type MonitorAction,
  type NotifyChannel,
  type MonitorLevel,
  type MonitorSettingsValues,
  type MonitorSignal,
  type Prisma,
  getMonitorSettings as readMonitorSettings,
  prisma,
  updateMonitorSettings as updateMonitorSettingsInDb,
} from "@magnemite/db";
import { requireOperator } from "@/lib/session";
import { hub } from "@/lib/hub";
import type { ActionState } from "./rollouts";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const SIGNALS = new Set<string>([
  "AGENT_OFFLINE",
  "SERVICE_DOWN",
  "APP_NOT_FOREGROUND",
  "APP_ANR",
  "HEALTH_CHECK_FAILED",
  "LOOP_STALLED",
  "ROTOM_DISCONNECTED",
  "ROTOM_NOT_SCANNING",
  "ROTOM_IDLE",
  "HOST_DOCKER_DOWN",
  "HOST_MEMORY_LOW",
  "HOST_DISK_LOW",
  "REDROID_INSTANCE_DOWN",
]);

const ACTIONS = new Set<string>([
  "NOTIFY_ONLY",
  "RESTART_APP",
  "KILL_APP",
  "CLEAR_CACHE_RESTART",
  "SEND_KEYEVENT",
  "START_SERVICE",
  "SHELL",
  "REBOOT",
  "ROTOM_RESTART",
  "ROTOM_DISCONNECT",
  "ROTOM_REBOOT",
  "RESTART_INSTANCE",
]);

const KINDS = new Set<string>(["BOX", "HOST"]);

/**
 * The signals that are about a machine rather than about a box.
 *
 * The same fact as `kinds` in the monitoring vocabulary, which is what keeps
 * the picker from offering the wrong pair in the first place. It is restated
 * here rather than imported for the reason the two lists above are: this
 * module runs on the server and that one pulls in an icon per label.
 *
 * `AGENT_OFFLINE` is in neither list, because it is the one signal that means
 * the same thing on both — something dialled out, heartbeat, and stopped.
 */
const HOST_SIGNALS = new Set<string>([
  "HOST_DOCKER_DOWN",
  "HOST_MEMORY_LOW",
  "HOST_DISK_LOW",
  "REDROID_INSTANCE_DOWN",
]);

/** The two that compare what is free against a floor in `config`. */
const FLOOR_SIGNALS = new Set<string>([
  "HOST_MEMORY_LOW",
  "HOST_DISK_LOW",
  "DEVICE_MEMORY_LOW",
  "DEVICE_STORAGE_LOW",
]);

/**
 * The signals that compare a reading against an absolute rather than a share.
 *
 * One, today. It is its own set rather than a flag on the floor because the
 * two read in opposite directions, and a single field that sometimes meant
 * "under" and sometimes "over" is the kind of control somebody sets backwards
 * once and reboots a fleet with.
 */
const CEILING_SIGNALS = new Set<string>(["DEVICE_TEMP_HIGH"]);

/**
 * What a machine can be told to do.
 *
 * Everything else in the catalog is an `am` or `pm` command, which a VPS has
 * no framework to run, or a Rotom call about a scanner it never had. A reboot
 * is missing on purpose: on a machine it would mean taking every box on it
 * down for one box's fault, which is what RESTART_INSTANCE exists to avoid.
 */
const HOST_ACTIONS = new Set<string>(["NOTIFY_ONLY", "SHELL", "RESTART_INSTANCE"]);

const LEVELS = new Set<string>(["INFO", "WARN", "CRITICAL"]);

/**
 * Tell the hub, best effort.
 *
 * A failure here is never an error: the values *are* saved. What it means is
 * that the hub is still running on the old ones, which has to be said rather
 * than left to be discovered — the same convention the hub settings form uses.
 */
async function tellHub(alsoBroadcast: boolean): Promise<boolean> {
  try {
    await hub.refreshSettings();
    // A changed rule changes what each box is told to probe, and that rides
    // the `welcome`. Without this, switching a rule on would do nothing until
    // every box happened to reconnect.
    if (alsoBroadcast) await hub.refreshTrackedPackages();
    return true;
  } catch {
    return false;
  }
}

function savedMessage(told: boolean): string {
  return told
    ? "Saved."
    : "Saved, but the hub could not be told, so it is still running on the old values. Restart it, or save again once it is back.";
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The timings and the ceilings. Where alerts go is Settings → Notifications
 * now, saved by `updateNotificationSettings`.
 */
export async function updateMonitorSettings(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireOperator();

  // A field that is absent means "this form does not own it" — not zero, not
  // empty — and keeps whatever is stored.
  //
  // The cards that shared this action used to mirror each other's values in
  // hidden inputs instead, which failed twice: one was missing the Rotom sync
  // interval, so saving a webhook was rejected over a number that form does not
  // have; the other posted no Discord fields at all, so saving a timing
  // silently wiped the webhook. Reading absence here is what makes both
  // impossible.
  const stored = await readMonitorSettings();
  const submitted = (name: string) => formData.get(name) !== null;

  const int = (name: string, min: number, fallback: number) => {
    if (!submitted(name)) return fallback;
    const parsed = Number(formData.get(name));
    if (!Number.isFinite(parsed) || parsed < min) return null;
    return Math.floor(parsed);
  };

  // One HTTP request for the whole fleet at once, against somebody else's
  // service — and the one it answers is the same `/api/device` its own
  // dashboard polls every five seconds. Five is the floor for that reason: it
  // is what Rotom already expects of a client, not a number picked here.
  const rotomSyncSeconds = int("rotomSyncSeconds", 5, stored.rotomSyncSeconds);
  // Floored against the Rotom sync interval below, not by a constant: 120 was
  // two of the 60s the sync used to be fixed at, and it stopped meaning that
  // the moment the interval became a setting.
  const rotomStaleSeconds = int("rotomStaleSeconds", 1, stored.rotomStaleSeconds);
  const rebootGraceSeconds = int("rebootGraceSeconds", 60, stored.rebootGraceSeconds);
  const startupGraceSeconds = int("startupGraceSeconds", 0, stored.startupGraceSeconds);
  const maxActionsPerDeviceHour = int("maxActionsPerDeviceHour", 1, stored.maxActionsPerDeviceHour);
  const maxRebootsPerDeviceDay = int("maxRebootsPerDeviceDay", 1, stored.maxRebootsPerDeviceDay);
  const eventRetentionDays = int("eventRetentionDays", 0, stored.eventRetentionDays);
  const autoCollectMinIntervalMinutes = int(
    "autoCollectMinIntervalMinutes",
    1,
    stored.autoCollectMinIntervalMinutes,
  );
  const autoCollectMaxPerHour = int("autoCollectMaxPerHour", 1, stored.autoCollectMaxPerHour);

  if (
    rotomSyncSeconds === null ||
    rotomStaleSeconds === null ||
    rebootGraceSeconds === null ||
    startupGraceSeconds === null ||
    maxActionsPerDeviceHour === null ||
    maxRebootsPerDeviceDay === null ||
    eventRetentionDays === null ||
    autoCollectMinIntervalMinutes === null ||
    autoCollectMaxPerHour === null
  ) {
    return {
      error:
        "Every field needs a whole number. The Rotom sync starts at 5 seconds, the reboot grace at 60, and the two ceilings at 1.",
    };
  }

  // Two sync intervals, because a box can never be fresher than the last time
  // anyone asked Rotom about it. Anything tighter alerts on the sync's own lag.
  // Checked against the pair that is about to be written — typed where the card
  // shows it, stored where it does not — so the two can never disagree, whichever
  // card the save came from.
  if (rotomStaleSeconds < rotomSyncSeconds * 2) {
    return {
      error: `Asking Rotom every ${rotomSyncSeconds}s means the stale delay has to be at least ${rotomSyncSeconds * 2}s — anything tighter alerts on the sync's own lag rather than on a box.`,
    };
  }

  const patch: Partial<MonitorSettingsValues> = {
    // Absent is "keep it", not "off": a card that does not show the master
    // switch posts nothing for it, and the switch itself saves through
    // setMonitorEnabled rather than through this form.
    enabled: submitted("enabled") ? formData.get("enabled") === "on" : stored.enabled,
    rotomSyncSeconds,
    rotomStaleSeconds,
    rebootGraceSeconds,
    startupGraceSeconds,
    maxActionsPerDeviceHour,
    maxRebootsPerDeviceDay,
    eventRetentionDays,
    // Same shape as `enabled` above: only read when this form actually carried
    // it, so a save from another form cannot silently switch it off.
    autoCollectLogsOnRecovery: submitted("autoCollectLogsOnRecovery")
      ? formData.get("autoCollectLogsOnRecovery") === "on"
      : stored.autoCollectLogsOnRecovery,
    autoCollectMinIntervalMinutes,
    autoCollectMaxPerHour,
  };
  await updateMonitorSettingsInDb(patch);

  const told = await tellHub(false);
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "settings.monitoring",
      meta: { ...patch, hubNotified: told },
    },
  });

  revalidatePath("/settings");
  return { ok: true, message: savedMessage(told) };
}

/**
 * The master switch, on its own.
 *
 * It sits above everything else on the tab and answers one question — is any
 * of this running — so it saves on the flick rather than through the form that
 * owns the numbers below it. Writing only `enabled` is what makes that safe:
 * the patch is partial, so nothing else in the group is touched by a switch
 * somebody flicked while a number below was half-edited.
 */
export async function setMonitorEnabled(enabled: boolean): Promise<ActionState> {
  const user = await requireOperator();
  await updateMonitorSettingsInDb({ enabled });

  const told = await tellHub(false);
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "settings.monitoring",
      meta: { enabled, hubNotified: told },
    },
  });

  revalidatePath("/settings");
  return { ok: true, message: savedMessage(told) };
}

/** Run a pass now rather than waiting for the next tick. */
export async function runMonitorNow(): Promise<ActionState> {
  await requireOperator();
  try {
    await hub.runMonitor();
    revalidatePath("/settings");
    return { ok: true, message: "Pass finished." };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

type ParsedRule = {
  name: string;
  signal: MonitorSignal;
  appliesTo: DeviceKind;
  packageName: string | null;
  groupId: string | null;
  config: Prisma.InputJsonValue;
  threshold: number;
  cooldownSeconds: number;
  windowStart: string | null;
  windowEnd: string | null;
  notifyLevel: MonitorLevel;
  notifyChannels: NotifyChannel[];
  notifyRecovery: boolean;
  enabled: boolean;
  steps: { atFailure: number; action: MonitorAction; command: string | null }[];
};

/**
 * Read one rule out of a form, or say what is wrong with it.
 *
 * Shared by create and update so the two cannot drift — a rule that could be
 * created but not saved again would be the worst kind of bug to find here.
 */
function parseRule(formData: FormData): ParsedRule | string {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return "Give the rule a name.";

  const signal = String(formData.get("signal") ?? "");
  if (!SIGNALS.has(signal)) return "Pick what the rule watches for.";

  // Boxes or the machines that host them. Absent reads as BOX, which is both
  // the column's default and what every rule written before hosts existed is.
  const appliesTo = String(formData.get("appliesTo") ?? "BOX");
  if (!KINDS.has(appliesTo)) return "Pick whether the rule watches boxes or machines.";

  // The pair is what the hub filters on: `rulesFor` drops a rule whose kind
  // does not match the machine in front of it before it reads a single
  // reading. So a mismatch here is not cosmetic -- it is a rule that saves
  // cleanly, shows as enabled, and can never fire.
  if (signal !== "AGENT_OFFLINE" && HOST_SIGNALS.has(signal) !== (appliesTo === "HOST")) {
    return appliesTo === "HOST"
      ? "That signal is about a box, not about the machine hosting it."
      : "That signal is about a machine. Switch what the rule watches, or pick a signal about the box.";
  }

  // The floor the four share-shaped signals compare against. Without it the
  // hub's `underFloor` reads *unknown*, which neither counts nor resets, so
  // the rule would sit there enabled and silent.
  const floor = Number(formData.get("minFreePercent"));
  const minFreePercent = Number.isFinite(floor) && floor > 0 && floor < 100 ? floor : null;
  if (FLOOR_SIGNALS.has(signal) && minFreePercent === null) {
    return "That signal compares what is free against a floor — give it a percentage between 1 and 99.";
  }

  // The same refusal for the same reason, one direction up. The range is wide
  // on purpose: these sensors report nonsense on some ROMs, and a form that
  // argued about plausible temperatures would be arguing with hardware it
  // cannot see.
  const ceiling = Number(formData.get("maxTempC"));
  const maxTempC = Number.isFinite(ceiling) && ceiling > 0 && ceiling < 150 ? ceiling : null;
  if (CEILING_SIGNALS.has(signal) && maxTempC === null) {
    return "That signal compares a temperature against a ceiling — give it a number between 1 and 149.";
  }

  const notifyLevel = String(formData.get("notifyLevel") ?? "WARN");
  if (!LEVELS.has(notifyLevel)) return "Pick a severity.";

  const int = (field: string, min: number, fallback: number) => {
    const parsed = Number(formData.get(field));
    return Number.isFinite(parsed) && parsed >= min ? Math.floor(parsed) : fallback;
  };

  const windowStart = String(formData.get("windowStart") ?? "").trim() || null;
  const windowEnd = String(formData.get("windowEnd") ?? "").trim() || null;
  if ((windowStart && !TIME_RE.test(windowStart)) || (windowEnd && !TIME_RE.test(windowEnd))) {
    return "The window needs times like 09:00 and 17:30.";
  }
  if (Boolean(windowStart) !== Boolean(windowEnd)) {
    return "A window needs both a start and an end, or neither.";
  }

  // Absent for a machine rule: the form does not show the field, because
  // nothing on a VPS could act on a package name.
  const packageName = String(formData.get("packageName") ?? "").trim() || null;
  // Three of the signals are about a specific app, and a rule that does not
  // name one would have nothing to force-stop.
  if (!packageName && ["APP_NOT_FOREGROUND", "APP_ANR", "SERVICE_DOWN"].includes(signal)) {
    return "That signal is about a particular app — give it a package name.";
  }

  const steps = parseSteps(formData, appliesTo as DeviceKind);
  if (typeof steps === "string") return steps;

  return {
    name,
    signal: signal as MonitorSignal,
    appliesTo: appliesTo as DeviceKind,
    packageName,
    groupId: String(formData.get("groupId") ?? "").trim() || null,
    config: parseConfig(formData, minFreePercent, maxTempC),
    threshold: int("threshold", 1, 1),
    cooldownSeconds: int("cooldownSeconds", 0, 300),
    windowStart,
    windowEnd,
    notifyLevel: notifyLevel as MonitorLevel,
    // Comma-joined by the picker so that "nowhere" arrives as an empty string
    // rather than as an absent field — a checkbox per channel would have made
    // "announce nowhere" indistinguishable from a form that omits them.
    // Unknown ids are dropped rather than rejected: they can only come from a
    // newer dialog against an older server, and a save is not the place to
    // find that out.
    notifyChannels: String(formData.get("notifyChannels") ?? "")
      .split(",")
      .filter((entry): entry is NotifyChannel =>
        (NOTIFY_CHANNELS as readonly string[]).includes(entry),
      ),
    // Only meaningful for a rule that announces somewhere, and the dialog
    // hides the switch when it does not — a hidden checkbox posts nothing, so
    // this reads false on its own rather than needing a second check.
    notifyRecovery: formData.get("notifyRecovery") === "on",
    enabled: formData.get("enabled") === "on",
    steps,
  };
}

/**
 * The probe, which is the half of a rule that travels to the box.
 *
 * Stored as JSON rather than columns because its shape follows the kind: a
 * shell check has a command and a pattern, a log check has a window and two
 * patterns and a ratio, and modelling all of that as nullable columns would be
 * a table nobody could read.
 */
function parseConfig(
  formData: FormData,
  minFreePercent: number | null,
  maxTempC: number | null,
): Prisma.InputJsonValue {
  // Both thresholds sit at the top of `config` rather than inside `probe`,
  // because nothing runs anywhere to answer them: the hub compares the columns
  // a box or a machine already reports on every heartbeat.
  const floor = {
    ...(minFreePercent === null ? {} : { minFreePercent }),
    ...(maxTempC === null ? {} : { maxTempC }),
  };

  const kind = String(formData.get("probeKind") ?? "").trim();
  const target = String(formData.get("probeTarget") ?? "").trim();
  // "none" is the form's way of saying the hub answers this signal by itself.
  if (!kind || kind === "none" || !target) return floor;

  const num = (field: string) => {
    const parsed = Number(formData.get(field));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };

  return {
    ...floor,
    probe: {
      kind,
      target,
      expect: String(formData.get("probeExpect") ?? "").trim() || null,
      lines: num("probeLines") ?? 200,
      failAt: num("probeFailAt") ?? 1,
      successPattern: String(formData.get("probeSuccessPattern") ?? "").trim() || null,
      maxRatio: num("probeMaxRatio"),
      maxAgeSeconds: num("probeMaxAgeSeconds"),
      timeoutSeconds: num("probeTimeoutSeconds") ?? 10,
    },
  };
}

/**
 * The escalation ladder, as parallel arrays out of the form's repeated rows.
 *
 * Deliberately strict about duplicate rungs: two actions at the same failure
 * count would both fire, which is how a box gets restarted and rebooted for
 * one fault.
 */
function parseSteps(formData: FormData, appliesTo: DeviceKind): ParsedRule["steps"] | string {
  const failures = formData.getAll("stepAtFailure").map(String);
  const actions = formData.getAll("stepAction").map(String);
  const commands = formData.getAll("stepCommand").map(String);

  const steps: ParsedRule["steps"] = [];
  const seen = new Set<number>();

  for (const [index, raw] of failures.entries()) {
    const action = actions[index];
    // An unknown action can only be a newer dialog against an older server, so
    // it is dropped rather than refused. A *known* action on the wrong kind of
    // machine is the opposite: it saves, and then reports "the rule has no
    // command to run" at the one moment it mattered. That is worth a sentence.
    if (!action || !ACTIONS.has(action)) continue;
    if (appliesTo === "HOST" ? !HOST_ACTIONS.has(action) : action === "RESTART_INSTANCE") {
      return appliesTo === "HOST"
        ? "A machine can only be told to notify, run a command, or restart one of its containers."
        : "Only a machine can restart a container — it is the one that runs them.";
    }

    const atFailure = Number(raw);
    if (!Number.isInteger(atFailure) || atFailure < 1) {
      return "Each step answers a failure count of 1 or more.";
    }
    if (seen.has(atFailure)) {
      return `Two steps both answer failure ${atFailure} — one rung, one action.`;
    }
    seen.add(atFailure);

    steps.push({
      atFailure,
      action: action as MonitorAction,
      command: (commands[index] ?? "").trim() || null,
    });
  }

  if (steps.length === 0) return "A rule needs at least one step, even if it only notifies.";
  return steps;
}

export async function createMonitorRule(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireOperator();
  const parsed = parseRule(formData);
  if (typeof parsed === "string") return { error: parsed };

  const { steps, ...rule } = parsed;
  const position = await prisma.monitorRule.count();
  const created = await prisma.monitorRule.create({
    data: { ...rule, position, steps: { create: steps } },
  });

  const told = await tellHub(rule.enabled);
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "monitorRule.create",
      targetType: "MonitorRule",
      targetId: created.id,
      meta: {
        name: rule.name,
        signal: rule.signal,
        appliesTo: rule.appliesTo,
        enabled: rule.enabled,
      },
    },
  });

  revalidatePath("/settings");
  return { ok: true, message: told ? `Created "${rule.name}".` : savedMessage(false) };
}

export async function updateMonitorRule(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireOperator();
  const id = String(formData.get("ruleId") ?? "");
  if (!id) return { error: "Missing rule." };

  const parsed = parseRule(formData);
  if (typeof parsed === "string") return { error: parsed };
  const { steps, ...rule } = parsed;

  // Replace the ladder wholesale rather than diffing it: the rungs are
  // identified by their failure count, which is exactly what an edit changes.
  await prisma.$transaction([
    prisma.monitorStep.deleteMany({ where: { ruleId: id } }),
    prisma.monitorRule.update({
      where: { id },
      data: { ...rule, steps: { create: steps } },
    }),
    // The counters are about the old rule. Keeping them would mean a rule
    // whose threshold just went up acting immediately on failures it counted
    // under the previous one.
    prisma.monitorState.deleteMany({ where: { ruleId: id } }),
  ]);

  const told = await tellHub(true);
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "monitorRule.update",
      targetType: "MonitorRule",
      targetId: id,
      meta: {
        name: rule.name,
        signal: rule.signal,
        appliesTo: rule.appliesTo,
        enabled: rule.enabled,
      },
    },
  });

  revalidatePath("/settings");
  return { ok: true, message: savedMessage(told) };
}

/**
 * The switch on a rule's row, without opening it.
 *
 * Turning a rule off is the thing people do most here — a rule that is firing
 * on a fault somebody is already fixing, or one being tried out on a quiet
 * fleet. Making that cost opening the editor and saving fourteen fields back
 * is how a rule gets left running when it should not be.
 */
export async function setMonitorRuleEnabled(id: string, enabled: boolean): Promise<ActionState> {
  const user = await requireOperator();
  const rule = await prisma.monitorRule.findUnique({ where: { id }, select: { name: true } });
  if (!rule) return { error: "That rule is already gone." };

  await prisma.$transaction([
    prisma.monitorRule.update({ where: { id }, data: { enabled } }),
    // The counters are about the rule as it was running. A rule switched back
    // on starts from nothing rather than acting on failures counted while
    // nobody was watching it.
    prisma.monitorState.deleteMany({ where: { ruleId: id } }),
  ]);

  const told = await tellHub(true);
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "monitorRule.update",
      targetType: "MonitorRule",
      targetId: id,
      meta: { name: rule.name, enabled, hubNotified: told },
    },
  });

  revalidatePath("/settings");
  return { ok: true, message: savedMessage(told) };
}

export async function deleteMonitorRule(id: string): Promise<ActionState> {
  const user = await requireOperator();
  const rule = await prisma.monitorRule.findUnique({ where: { id }, select: { name: true } });
  if (!rule) return { error: "That rule is already gone." };

  await prisma.monitorRule.delete({ where: { id } });
  await tellHub(true);

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "monitorRule.delete",
      targetType: "MonitorRule",
      targetId: id,
      meta: { name: rule.name },
    },
  });

  revalidatePath("/settings");
  return { ok: true, message: `Removed "${rule.name}".` };
}
