"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { checkConfigTemplate, CONFIG_PLACEHOLDERS } from "@/lib/config-placeholders";
import {
  generateToken,
  getHubSettings as readHubSettings,
  getMonitorSettings as readMonitorSettings,
  hashToken,
  type HubSettingsValues,
  prisma,
  type RedroidSettingsValues,
  tokenPrefix,
  updateHubSettings as updateHubSettingsInDb,
  updateRedroidSettings as updateRedroidSettingsInDb,
} from "@magnemite/db";
import { requireOperator } from "@/lib/session";
import { hub } from "@/lib/hub";
import type { ActionState } from "./rollouts";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * How often to read one index, in minutes.
 *
 * Falls back to the old fleet-wide default rather than rejecting: a stale form
 * that posts nothing should leave a source on a sane cadence, not on zero.
 */
function pollMinutes(formData: FormData): number {
  const parsed = Number(formData.get("pollMinutes"));
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 15;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * What a hub-settings save reports back.
 *
 * `pushed` is how many boxes were handed the new heartbeat then and there,
 * and it is a number rather than a sentence because the wording is the form's
 * to choose. Absent whenever the save left the heartbeat alone.
 */
export type HubSettingsState = ActionState & { pushed?: number };

/** Fleet-wide operational knobs — max concurrent jobs, stall timeout, and so on. */
export async function updateHubSettings(
  _prev: HubSettingsState,
  formData: FormData,
): Promise<HubSettingsState> {
  const user = await requireOperator();

  const int = (name: string, min: number) => {
    const parsed = Number(formData.get(name));
    if (!Number.isFinite(parsed) || parsed < min) return null;
    return Math.floor(parsed);
  };

  const maxConcurrentJobs = int("maxConcurrentJobs", 1);
  const jobStallTimeoutSeconds = int("jobStallTimeoutSeconds", 1);
  const heartbeatSeconds = int("heartbeatSeconds", 5);
  const agentUpdateConcurrency = int("agentUpdateConcurrency", 1);
  // Three missed 20-second heartbeats is the floor that stops a box flapping
  // offline on one dropped beat.
  const deviceOfflineTimeoutSeconds = int("deviceOfflineTimeoutSeconds", 30);

  if (
    maxConcurrentJobs === null ||
    jobStallTimeoutSeconds === null ||
    agentUpdateConcurrency === null ||
    deviceOfflineTimeoutSeconds === null ||
    heartbeatSeconds === null
  ) {
    return {
      error:
        "Every field needs a whole number — 1 or more. The heartbeat starts at 5 and the offline timeout at 30.",
    };
  }

  // Two of these are really measured in heartbeats, and the numbers only mean
  // anything against it. Letting them through unchecked is how a fleet ends up
  // flapping between online and offline on one missed beat, which looks like a
  // network fault and is really a form that allowed nonsense.
  if (deviceOfflineTimeoutSeconds < heartbeatSeconds * 3) {
    return {
      error: `The offline timeout has to allow at least three missed heartbeats — ${heartbeatSeconds * 3}s or more at a ${heartbeatSeconds}s heartbeat. Otherwise one dropped beat marks a box offline.`,
    };
  }
  const patch: Partial<HubSettingsValues> = {
    maxConcurrentJobs,
    jobStallTimeoutSeconds,
    heartbeatSeconds,
    agentUpdateConcurrency,
    deviceOfflineTimeoutSeconds,
  };
  await updateHubSettingsInDb(patch);

  // The hub holds its own copy and no longer re-reads on a timer, so it is
  // told rather than left to notice. The reply is the confirmation: if it does
  // not come, the values are still saved but the hub is running on the old
  // ones, and that has to be said rather than left to be discovered.
  let told = true;
  let pushed = 0;
  try {
    pushed = (await hub.refreshSettings()).pushed ?? 0;
  } catch {
    told = false;
  }

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "settings.hub",
      meta: { ...patch, hubNotified: told, welcomePushed: pushed },
    },
  });

  revalidatePath("/settings");
  return {
    ok: true,
    // The heartbeat is the one knob here that does not land everywhere at
    // once. Zero boxes means the save left it alone — or that none were
    // connected to take it — and either way there is nothing to say.
    pushed: pushed > 0 ? pushed : undefined,
    message: told
      ? "Saved."
      : "Saved, but the hub could not be told, it is still running on the old values. Restart it, or save again once it is back.",
  };
}

const GB = 1024 ** 3;

/**
 * The knobs behind the containers: how big one is, how many a machine holds,
 * and how many start at once.
 *
 * Its own card and its own save, apart from the hub knobs, because nothing
 * here is measured against the heartbeat and because these reach the fleet by
 * a completely different road. The hub keeps no copy of them -- `readGroup`
 * goes to the table on every read -- so there is no cache to drop and no
 * `refreshSettings` call below.
 *
 * What there is instead is a delay nobody should have to discover: two of
 * these are rendered into each machine's compose file, and docker applies them
 * when a container is **created**. Saving changes the plan immediately and the
 * running containers not at all, until each machine is re-applied. That is
 * deliberately not done here -- recreating every container on every machine is
 * not a thing a Save button should do without being asked.
 */
export async function updateRedroidSettings(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireOperator();

  const num = (name: string) => {
    const parsed = Number(formData.get(name));
    return Number.isFinite(parsed) ? parsed : null;
  };

  const memLimitGb = num("memLimitGb");
  const hostReserveGb = num("hostReserveGb");
  const workersPerInstance = num("workersPerInstance");
  const workersPerVCpu = num("workersPerVCpu");
  const startBatchSize = num("startBatchSize");
  const gpuMode = String(formData.get("gpuMode") ?? "").trim();

  if (
    memLimitGb === null ||
    hostReserveGb === null ||
    workersPerInstance === null ||
    workersPerVCpu === null ||
    startBatchSize === null
  ) {
    return { error: "Every field needs a number." };
  }
  // The floor is where Android stops booting rather than where it gets slow:
  // Android 12 and a scanner in less than half a gigabyte OOMs in a loop that
  // reads as a container that will not start.
  if (memLimitGb < 0.5 || memLimitGb > 64) {
    return { error: "Memory per container must be between 0.5 and 64 GB." };
  }
  // Zero is allowed and means hold nothing back, which is a real answer on a
  // machine that runs nothing else.
  if (hostReserveGb < 0 || hostReserveGb > 64) {
    return { error: "Reserved for the machine must be between 0 and 64 GB." };
  }
  if (!Number.isInteger(workersPerInstance) || workersPerInstance < 1 || workersPerInstance > 50) {
    // 50 is where the scanners stop being happy, and on some licences it is
    // also the contractual ceiling.
    return { error: "Workers per container must be a whole number between 1 and 50." };
  }
  if (!Number.isInteger(workersPerVCpu) || workersPerVCpu < 1 || workersPerVCpu > 200) {
    return { error: "Workers per vCPU must be a whole number between 1 and 200." };
  }
  if (!Number.isInteger(startBatchSize) || startBatchSize < 1 || startBatchSize > 32) {
    return { error: "Containers started at once must be a whole number between 1 and 32." };
  }
  if (!gpuMode) return { error: "Pick a GPU mode." };

  const patch: Partial<RedroidSettingsValues> = {
    memLimitBytes: Math.round(memLimitGb * GB),
    hostReserveBytes: Math.round(hostReserveGb * GB),
    workersPerInstance,
    workersPerVCpu,
    startBatchSize,
    gpuMode,
  };
  await updateRedroidSettingsInDb(patch);

  await prisma.auditLog.create({
    data: { userId: user.id, userEmail: user.email, action: "settings.redroid", meta: patch },
  });

  revalidatePath("/settings");
  // The capacity figure on every machine's page is computed from these, so it
  // is stale the moment they move.
  revalidatePath("/hosts");
  return {
    ok: true,
    message:
      "Saved. The memory ceiling reaches a machine's containers when it is next re-applied — docker sets it as they are created.",
  };
}

/**
 * How much history to keep, for both kinds of it.
 *
 * Its own card and its own save, apart from the operational knobs above,
 * because the two pairs answer the same two questions about different sources
 * and their floors come from different places: a heartbeat sample cannot
 * usefully be finer than the heartbeat, a Rotom sample cannot usefully be finer
 * than the Rotom sync.
 *
 * Both floors are checked against what is **stored**, not against a field on
 * this form — the numbers they are floored by live on two other cards. That
 * leaves the reverse direction open: raising the heartbeat past a sample
 * interval that was already saved is not refused here. It does not have to be.
 * Asking for a sample finer than its source stores every reading and no more,
 * which is a wasted row rather than a broken chart, and refusing a heartbeat
 * change because of a number two cards away would be the more confusing half of
 * the trade.
 */
export async function updateMetricHistory(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireOperator();

  const int = (name: string, min: number) => {
    const parsed = Number(formData.get(name));
    if (!Number.isFinite(parsed) || parsed < min) return null;
    return Math.floor(parsed);
  };

  const metricsSampleSeconds = int("metricsSampleSeconds", 1);
  const rotomSampleSeconds = int("rotomSampleSeconds", 1);
  // 0 is meaningful for both — it turns that history off and drops what is
  // already stored on the next prune.
  const metricsRetentionDays = int("metricsRetentionDays", 0);
  const rotomRetentionDays = int("rotomRetentionDays", 0);

  if (
    metricsSampleSeconds === null ||
    rotomSampleSeconds === null ||
    metricsRetentionDays === null ||
    rotomRetentionDays === null
  ) {
    return {
      error: "Every field needs a whole number — 1 or more for the intervals, 0 or more for days.",
    };
  }

  const [hubSettings, monitorSettings] = await Promise.all([
    readHubSettings(),
    readMonitorSettings(),
  ]);

  if (metricsSampleSeconds < hubSettings.heartbeatSeconds) {
    return {
      error: `Boxes report every ${hubSettings.heartbeatSeconds}s, so sampling faster than that keeps every beat and nothing more. Raise the heartbeat first if you want finer device history.`,
    };
  }
  if (rotomSampleSeconds < monitorSettings.rotomSyncSeconds) {
    return {
      error: `Rotom is asked every ${monitorSettings.rotomSyncSeconds}s, so sampling faster than that keeps every sync and nothing more. Lower "Ask Rotom every" on the Monitoring card first if you want finer scanner history.`,
    };
  }

  const patch: Partial<HubSettingsValues> = {
    metricsSampleSeconds,
    metricsRetentionDays,
    rotomSampleSeconds,
    rotomRetentionDays,
  };
  await updateHubSettingsInDb(patch);

  let told = true;
  try {
    await hub.refreshSettings();
  } catch {
    told = false;
  }

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "settings.metricHistory",
      meta: { ...patch, hubNotified: told },
    },
  });

  revalidatePath("/settings");
  return {
    ok: true,
    message: told
      ? "Saved."
      : "Saved, but the hub could not be told, it is still running on the old values. Restart it, or save again once it is back.",
  };
}

/** Hooks, the concurrency cap, and the MITM data for one device group. */
export async function updateGroup(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireOperator();
  const id = String(formData.get("groupId") ?? "");
  if (!id) return { error: "Missing group." };

  const rawConcurrency = String(formData.get("maxConcurrency") ?? "").trim();
  const parsed = Number(rawConcurrency);
  const maxConcurrency =
    rawConcurrency === ""
      ? null
      : Number.isFinite(parsed) && parsed > 0
        ? Math.floor(parsed)
        : null;

  const field = (name: string) => String(formData.get(name) ?? "").trim() || null;
  const mitmPackageName = field("mitmPackageName");
  const mitmConfigPath = field("mitmConfigPath");
  const mitmConfig = field("mitmConfig");

  if (mitmPackageName && !PACKAGE_NAME.test(mitmPackageName)) {
    return { error: "That is not a package name — try com.pokemod.aegis." };
  }
  // A path with no config would push an empty file over a working one, and a
  // config with no path has nowhere to go. Either both or neither.
  if (Boolean(mitmConfigPath) !== Boolean(mitmConfig)) {
    return { error: "A config needs both a file path and its contents — set both, or neither." };
  }
  if (mitmConfigPath) {
    const bad = checkConfigPath(mitmConfigPath);
    if (bad) return { error: bad };
  }
  if (mitmConfig) {
    const bad = checkConfigTemplate(mitmConfig);
    if (bad) return { error: bad };
  }

  const before = await prisma.deviceGroup.findUnique({
    where: { id },
    select: { mitmPackageName: true },
  });

  await prisma.deviceGroup.update({
    where: { id },
    data: {
      preInstallHook: field("preInstallHook"),
      postInstallHook: field("postInstallHook"),
      maxConcurrency,
      mitmPackageName,
      mitmLabel: field("mitmLabel"),
      mitmConfigPath,
      mitmConfig,
    },
  });

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "deviceGroup.update",
      targetType: "DeviceGroup",
      targetId: id,
      // The config's size, never the config: it holds the bearer tokens the
      // MITM authenticates with.
      meta: { mitmPackageName, mitmConfigPath, configBytes: mitmConfig?.length ?? 0 },
    },
  });

  // The MITM package is in the list every box reports on, so a changed one has
  // to reach the fleet for its column to fill in — otherwise it waits for each
  // box to happen to reconnect.
  if (before?.mitmPackageName !== mitmPackageName) {
    await hub.refreshTrackedPackages().catch(() => undefined);
    revalidatePath("/");
  }

  revalidatePath("/settings");
  return { ok: true, message: "Saved." };
}

/**
 * The same refusals the agent enforces, restated here so an operator hears
 * about a bad path at Save rather than sixty seconds into a push.
 */
function checkConfigPath(p: string): string | null {
  if (!p.startsWith("/")) return `${p} is not an absolute path.`;
  // The agent refuses anything where `path.Clean(p) != p`, which is a wider
  // net than spotting `..` and `//`: `/data/local/./tmp/x.json` used to save
  // here and then fail on every box in the group with "path must be
  // normalised", with nothing on this form saying the stored value was
  // unusable. Same rule, so the refusal happens at Save.
  if (p !== normalisePath(p)) return `${p} is not a normalised path — try ${normalisePath(p)}.`;
  for (const root of [
    "/system",
    "/vendor",
    "/product",
    "/apex",
    "/proc",
    "/sys",
    "/dev",
    "/boot",
  ]) {
    if (p === root || p.startsWith(`${root}/`)) return `Nothing may be written under ${root}.`;
  }
  // This file holds each box's device token. A config push able to reach it
  // would be a way to rewrite the whole fleet's credentials.
  if (p.startsWith("/data/adb/magnemite/")) {
    return "That is the agent's own directory — writing there would lock Magnemite out of the box.";
  }
  return null;
}

/** `path.Clean` for the handful of shapes a config path can take. */
function normalisePath(p: string): string {
  const segments: string[] = [];
  for (const segment of p.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

export async function createGroup(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireOperator();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Give the group a name." };

  const existing = await prisma.deviceGroup.findUnique({ where: { name } });
  if (existing) return { error: `A group called "${name}" already exists.` };

  await prisma.deviceGroup.create({ data: { name } });
  revalidatePath("/settings");
  return { ok: true, message: `Created "${name}".` };
}

/**
 * Devices in the group are not deleted — `Device.groupId` just goes back to
 * null, so they simply have no group until reassigned.
 */
export async function deleteGroup(id: string): Promise<ActionState> {
  const user = await requireOperator();
  const group = await prisma.deviceGroup.findUnique({ where: { id }, select: { name: true } });
  if (!group) return { error: "That group is already gone." };

  await prisma.deviceGroup.delete({ where: { id } });

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "deviceGroup.delete",
      targetType: "DeviceGroup",
      targetId: id,
      meta: { name: group.name },
    },
  });

  revalidatePath("/settings");
  return { ok: true, message: `Removed "${group.name}".` };
}

/**
 * Add a build to what a group hands every box that joins it.
 *
 * One row per build per group, so pressing Add twice on the same build is the
 * same instruction rather than two. A build that is not cached is refused
 * here, because the alternative is discovering it at the one moment nobody is
 * watching -- a container coming up at four in the morning.
 */
export async function addJoinInstall(groupId: string, appVersionId: string): Promise<ActionState> {
  const user = await requireOperator();

  const [group, version] = await Promise.all([
    prisma.deviceGroup.findUnique({ where: { id: groupId }, select: { name: true } }),
    prisma.appVersion.findUnique({
      where: { id: appVersionId },
      select: { version: true, status: true, appTarget: { select: { packageName: true } } },
    }),
  ]);
  if (!group) return { error: "That group is already gone." };
  if (!version) return { error: "That build is already gone." };
  if (version.status !== "READY") {
    return { error: `${version.version} is not cached yet — cache it before adding it here.` };
  }

  // One build per package, because two would mean a new box installing one
  // over the other in whichever order the scheduler happened to pick.
  const clash = await prisma.groupJoinInstall.findFirst({
    where: { groupId, appVersion: { appTarget: { packageName: version.appTarget.packageName } } },
    select: { id: true, appVersion: { select: { version: true } } },
  });
  if (clash) {
    return {
      error: `This group already gives new boxes ${version.appTarget.packageName} ${clash.appVersion.version}. Remove that one first.`,
    };
  }

  await prisma.groupJoinInstall.create({ data: { groupId, appVersionId } });

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "groupJoinInstall.add",
      targetType: "DeviceGroup",
      targetId: groupId,
      meta: {
        group: group.name,
        packageName: version.appTarget.packageName,
        version: version.version,
      },
    },
  });

  revalidatePath("/settings");
  return { ok: true, message: `New boxes in "${group.name}" will get ${version.version}.` };
}

/**
 * Stop handing a build to new boxes.
 *
 * Nothing is uninstalled. The boxes that already got it keep it, which is the
 * only sane reading of removing an instruction about the future.
 */
export async function removeJoinInstall(id: string): Promise<ActionState> {
  const user = await requireOperator();
  const row = await prisma.groupJoinInstall.findUnique({
    where: { id },
    select: {
      group: { select: { name: true } },
      appVersion: { select: { version: true, appTarget: { select: { packageName: true } } } },
    },
  });
  if (!row) return { error: "That is already gone." };

  await prisma.groupJoinInstall.delete({ where: { id } });

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "groupJoinInstall.remove",
      targetType: "DeviceGroup",
      targetId: id,
      meta: {
        group: row.group.name,
        packageName: row.appVersion.appTarget.packageName,
        version: row.appVersion.version,
      },
    },
  });

  revalidatePath("/settings");
  return { ok: true, message: "New boxes will no longer get it." };
}

/** Same shape the hub validates uploads against. */
const PACKAGE_NAME = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

/** Creates a new app target with default auto-update policy, off by default. */
export async function createAppTarget(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireOperator();
  const packageName = String(formData.get("packageName") ?? "").trim();
  const displayName = String(formData.get("displayName") ?? "").trim();

  if (!packageName || !PACKAGE_NAME.test(packageName)) {
    return { error: "Package name looks wrong — expected something like com.example.app." };
  }
  if (!displayName) return { error: "Give it a display name." };

  const existing = await prisma.appTarget.findUnique({ where: { packageName } });
  if (existing) return { error: `"${packageName}" is already configured.` };

  const feedIds = formData.getAll("sourceIds").map(String).filter(Boolean);
  if (feedIds.length === 0) {
    return { error: "Pick at least one version source — a target with none is never polled." };
  }
  // Guard against a stale form naming a feed that has since been removed:
  // `createMany` on the join would fail on the foreign key with nothing useful
  // to show.
  const feeds = await prisma.sourceFeed.findMany({
    where: { id: { in: feedIds } },
    select: { id: true },
  });
  if (feeds.length !== feedIds.length) {
    return { error: "One of those version sources no longer exists — reload and try again." };
  }

  const target = await prisma.appTarget.create({
    data: {
      packageName,
      displayName,
      sources: { create: feeds.map((feed) => ({ feedId: feed.id })) },
    },
  });

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "appTarget.create",
      targetType: "AppTarget",
      targetId: target.id,
      meta: { packageName, displayName, feedIds },
    },
  });

  revalidatePath("/settings");
  revalidatePath("/versions");
  revalidatePath("/");
  return { ok: true, message: `Created "${displayName}".` };
}

/**
 * Everything about one app target: what it is, where it is polled from, and
 * how its rollouts start.
 *
 * One action because it is one card and one Save. Changing the package name
 * only changes what Magnemite polls and installs — the versions each box has
 * already reported are keyed by the old package string and stay where they
 * are, so the fleet columns go quiet until the boxes report the new one.
 */
export async function updateAppTarget(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireOperator();
  const id = String(formData.get("appTargetId") ?? "");
  if (!id) return { error: "Missing app target." };

  const packageName = String(formData.get("packageName") ?? "").trim();
  const displayName = String(formData.get("displayName") ?? "").trim();

  if (!packageName || !PACKAGE_NAME.test(packageName)) {
    return { error: "Package name looks wrong — expected something like com.example.app." };
  }
  if (!displayName) return { error: "Give it a display name." };

  const clash = await prisma.appTarget.findUnique({ where: { packageName } });
  if (clash && clash.id !== id) return { error: `"${packageName}" is already configured.` };

  const feedIds = formData.getAll("sourceIds").map(String).filter(Boolean);
  if (feedIds.length === 0) {
    return { error: "Pick at least one version source — a target with none is never polled." };
  }
  const feeds = await prisma.sourceFeed.findMany({
    where: { id: { in: feedIds } },
    select: { id: true },
  });
  if (feeds.length !== feedIds.length) {
    return { error: "One of those version sources no longer exists — reload and try again." };
  }

  // A disabled field submits nothing at all, and the card greys the policy out
  // whenever automatic rollouts are off. Absence therefore has to mean "leave
  // this as it was": read as a value, an unsent canary count is `Number(null)`
  // — zero, not the default — so turning the switch off would quietly reset
  // the policy that turning it back on is supposed to restore.
  const sent = (name: string) => formData.get(name) !== null;

  const data: Prisma.AppTargetUpdateInput = {
    packageName,
    displayName,
    // Switches are the exception: an unticked one sends nothing either, and
    // there absence is the value.
    autoUpdateEnabled: formData.get("autoUpdateEnabled") === "on",
    autoApprove: formData.get("autoApprove") === "on",
  };

  const int = (name: string, fallback: number) => {
    const parsed = Number(formData.get(name));
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
  };

  if (sent("canaryCount")) data.canaryCount = int("canaryCount", 1);
  if (sent("soakMinutes")) data.soakMinutes = int("soakMinutes", 30);
  if (sent("maxAttempts")) data.maxAttempts = Math.max(1, int("maxAttempts", 3));
  if (sent("retryBackoffSeconds")) data.retryBackoffSeconds = int("retryBackoffSeconds", 60);
  // Used to be one number for the whole fleet in Settings → Tuning. 0 is a real
  // value here — it means ship as soon as a build is discovered — which is why
  // it goes through the same `sent` guard as the rest of the policy.
  if (sent("updateCooldownMinutes")) data.updateCooldownMinutes = int("updateCooldownMinutes", 0);

  if (sent("windowStart") || sent("windowEnd")) {
    const windowStart = String(formData.get("windowStart") ?? "").trim();
    const windowEnd = String(formData.get("windowEnd") ?? "").trim();
    if (windowStart && !TIME_RE.test(windowStart)) return { error: "Start time must be HH:MM." };
    if (windowEnd && !TIME_RE.test(windowEnd)) return { error: "End time must be HH:MM." };
    if (Boolean(windowStart) !== Boolean(windowEnd)) {
      return { error: "Set both ends of the window, or neither." };
    }
    data.windowStart = windowStart || null;
    data.windowEnd = windowEnd || null;
  }

  // The pairing is replaced wholesale: the form posts the full set every time,
  // so anything missing from it was unticked. Versions already discovered keep
  // pointing at the feed that listed them.
  await prisma.$transaction([
    prisma.appTargetSource.deleteMany({ where: { appTargetId: id, feedId: { notIn: feedIds } } }),
    prisma.appTargetSource.createMany({
      data: feeds.map((feed) => ({ appTargetId: id, feedId: feed.id })),
      skipDuplicates: true,
    }),
    prisma.appTarget.update({ where: { id }, data }),
  ]);

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "appTarget.update",
      targetType: "AppTarget",
      targetId: id,
      meta: { packageName, displayName, feedIds },
    },
  });

  revalidatePath("/settings");
  revalidatePath("/versions");
  revalidatePath("/");
  return { ok: true, message: "Saved." };
}

/**
 * Remove the app target, and every version discovered for it.
 *
 * Versions cascade with the target, but a rollout pins the version it shipped
 * (`onDelete: Restrict`), so the database refuses outright once there is any
 * history. That is worth saying plainly rather than surfacing as a foreign key
 * error from a delete that looked like it should work.
 */
export async function deleteAppTarget(id: string): Promise<ActionState> {
  const user = await requireOperator();
  const target = await prisma.appTarget.findUnique({
    where: { id },
    select: { displayName: true, packageName: true },
  });
  if (!target) return { error: "That app target is already gone." };

  const rollouts = await prisma.rollout.count({ where: { appVersion: { appTargetId: id } } });
  if (rollouts > 0) {
    return {
      error: `"${target.displayName}" has ${rollouts} rollout${rollouts === 1 ? "" : "s"} behind it. Removing it would take the versions they shipped, so it cannot be deleted while that history exists.`,
    };
  }

  await prisma.appTarget.delete({ where: { id } });

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "appTarget.delete",
      targetType: "AppTarget",
      targetId: id,
      meta: { packageName: target.packageName, displayName: target.displayName },
    },
  });

  revalidatePath("/settings");
  revalidatePath("/versions");
  revalidatePath("/");
  return { ok: true, message: `Removed "${target.displayName}".` };
}

/**
 * Add a version source.
 *
 * Any index in the shape the UnownHash mirror publishes works, which is why
 * this is a URL in the dashboard rather than an integration in the code. A
 * feed whose entries carry absolute `url` fields needs no base URL; one that
 * lists bare filenames does, and the Status page says so when it is missing.
 */
export async function createSourceFeed(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireOperator();
  const name = String(formData.get("name") ?? "").trim();
  const indexUrl = String(formData.get("indexUrl") ?? "").trim();
  const baseUrl = String(formData.get("baseUrl") ?? "").trim();

  if (!name) return { error: "Give the source a name." };
  if (!isHttpUrl(indexUrl)) return { error: "The index URL must be http(s)." };
  if (baseUrl && !isHttpUrl(baseUrl)) return { error: "The base URL must be http(s)." };

  const existing = await prisma.sourceFeed.findUnique({ where: { name } });
  if (existing) return { error: `A source called "${name}" already exists.` };

  const parsedPriority = Number(formData.get("priority"));
  const last = await prisma.sourceFeed.findFirst({ orderBy: { priority: "desc" } });

  const feed = await prisma.sourceFeed.create({
    data: {
      name,
      indexUrl,
      baseUrl: baseUrl || null,
      pollMinutes: pollMinutes(formData),
      // New sources go last, so adding one never changes where existing
      // builds are downloaded from.
      priority:
        Number.isFinite(parsedPriority) && parsedPriority > 0
          ? Math.floor(parsedPriority)
          : (last?.priority ?? 0) + 100,
    },
  });

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "sourceFeed.create",
      targetType: "SourceFeed",
      targetId: feed.id,
      meta: { name, indexUrl },
    },
  });

  revalidatePath("/settings");
  revalidatePath("/status");
  return { ok: true, message: `Added "${name}". It is polled on the next cycle.` };
}

export async function updateSourceFeed(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireOperator();
  const id = String(formData.get("feedId") ?? "");
  if (!id) return { error: "Missing source." };

  const indexUrl = String(formData.get("indexUrl") ?? "").trim();
  const baseUrl = String(formData.get("baseUrl") ?? "").trim();
  if (!isHttpUrl(indexUrl)) return { error: "The index URL must be http(s)." };
  if (baseUrl && !isHttpUrl(baseUrl)) return { error: "The base URL must be http(s)." };

  const parsedPriority = Number(formData.get("priority"));
  const enabled = formData.get("enabled") === "on";
  const minutes = pollMinutes(formData);

  const before = await prisma.sourceFeed.findUnique({
    where: { id },
    select: { indexUrl: true, baseUrl: true, enabled: true },
  });
  if (!before) return { error: "That source is already gone." };

  await prisma.sourceFeed.update({
    where: { id },
    data: {
      indexUrl,
      baseUrl: baseUrl || null,
      enabled,
      pollMinutes: minutes,
      ...(Number.isFinite(parsedPriority) && parsedPriority > 0
        ? { priority: Math.floor(parsedPriority) }
        : {}),
    },
  });

  // Where a build is downloaded from is built from these two, and it is stored
  // on the version at discovery time. Editing them and leaving every known
  // build pointing at the old URL is the kind of change that looks like it did
  // nothing — so re-poll now rather than at the top of the next interval,
  // which rewrites those URLs (and un-fails anything that failed on the old
  // one). Priority is not in here: it only decides ties between feeds and
  // changes no URL.
  const rePoint =
    before.indexUrl !== indexUrl ||
    (before.baseUrl ?? "") !== baseUrl ||
    (!before.enabled && enabled);

  // A hub that is down must not make the save look like it failed: the setting
  // is stored either way, and the scheduled poll will catch up.
  let polled = true;
  if (rePoint) {
    try {
      await hub.pollSources();
    } catch {
      polled = false;
    }
  }

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "sourceFeed.update",
      targetType: "SourceFeed",
      targetId: id,
    },
  });

  revalidatePath("/settings");
  revalidatePath("/status");
  revalidatePath("/versions");
  return {
    ok: true,
    message: rePoint
      ? polled
        ? "Saved — re-checking the source now, which repoints the builds it already found."
        : "Saved, but the hub could not be reached to re-check now. Known builds keep their old URLs until the next poll."
      : "Saved.",
  };
}

/**
 * Remove a source.
 *
 * Builds it discovered stay: the .apkm may be cached and a rollout may be
 * pointing at it, so the rows simply lose their feed. What stops is the
 * polling.
 */
export async function deleteSourceFeed(id: string): Promise<ActionState> {
  const user = await requireOperator();
  const feed = await prisma.sourceFeed.findUnique({ where: { id }, select: { name: true } });
  if (!feed) return { error: "That source is already gone." };

  await prisma.sourceFeed.delete({ where: { id } });

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "sourceFeed.delete",
      targetType: "SourceFeed",
      targetId: id,
      meta: { name: feed.name },
    },
  });

  revalidatePath("/settings");
  revalidatePath("/status");
  return { ok: true, message: `Removed "${feed.name}".` };
}

/**
 * Mints an enrollment token. The plaintext is returned once and never stored —
 * only its hash goes in the database.
 */
export async function createEnrollmentToken(
  _prev: ActionState & { token?: string; kind?: "BOX" | "HOST" },
  formData: FormData,
): Promise<ActionState & { token?: string; kind?: "BOX" | "HOST" }> {
  const user = await requireOperator();
  const label = String(formData.get("label") ?? "").trim() || "untitled";
  const rawMaxUses = String(formData.get("maxUses") ?? "").trim();
  const parsedUses = Number(rawMaxUses);
  // A machine token, for provisioning a host by hand. The one click mints its
  // own per machine and nobody ever sees it, so this exists for the manual
  // path -- which the bootstrap docs describe and which, without this, had
  // nowhere to get a token from: a BOX token enrols a machine as a *box*, and
  // the only sign is a device that never grows a Machines page.
  const kind = formData.get("kind") === "HOST" ? ("HOST" as const) : ("BOX" as const);

  const token = generateToken();
  await prisma.enrollmentToken.create({
    data: {
      label,
      tokenHash: hashToken(token),
      prefix: tokenPrefix(token),
      kind,
      // Forced for HOST, which is why the form offers no switch for it:
      // `/internal/authz` refuses an unapproved device, so a machine that
      // enrolled pending would get a bare 401 from the edge on its first
      // self-update with nothing anywhere to say why.
      autoApprove: kind === "HOST" ? true : formData.get("autoApprove") === "on",
      maxUses: rawMaxUses === "" ? null : Number.isFinite(parsedUses) ? parsedUses : null,
    },
  });

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "enrollmentToken.create",
      meta: { label, kind },
    },
  });

  revalidatePath("/settings");
  // The kind comes back so the panel can show what to *do* with the token it
  // just printed. Pasting a machine token into a box's config.json, or into
  // `make module`, is a plausible mistake that nothing downstream catches.
  return { ok: true, token, kind, message: "Copy this now — it is not shown again." };
}

export async function revokeEnrollmentToken(id: string): Promise<ActionState> {
  await requireOperator();
  await prisma.enrollmentToken.update({ where: { id }, data: { revoked: true } });
  revalidatePath("/settings");
  return { ok: true };
}
