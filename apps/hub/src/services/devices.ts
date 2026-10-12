import type { deviceInfoSchema, deviceMetricsSchema } from "@magnemite/protocol";
import type { z } from "zod";
import { prisma } from "@magnemite/db";
import { getHubSettings } from "./hubSettings.js";
import { bus } from "../bus.js";
import { log } from "../log.js";
import { onlineDeviceIds, sendTo } from "../registry.js";
import { recordSample } from "./metrics.js";
import { forgetReading, loadEnabledRules, recordReading, specFor } from "./monitor.js";

type DeviceInfo = z.infer<typeof deviceInfoSchema>;
type DeviceMetrics = z.infer<typeof deviceMetricsSchema>;

function toBigInt(value: number | string | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  try {
    return BigInt(typeof value === "number" ? Math.trunc(value) : value);
  } catch {
    return null;
  }
}

export async function markOnline(
  deviceId: string,
  opts: {
    agentVersion: string;
    publicIp: string | null;
    info: DeviceInfo;
    capabilities: string[];
  },
) {
  await prisma.device.update({
    where: { id: deviceId },
    data: {
      status: "ONLINE",
      lastSeenAt: new Date(),
      agentVersion: opts.agentVersion,
      // Replaced outright on every hello, empty list included: a rolled-back
      // agent has to stop claiming what it can no longer do.
      capabilities: opts.capabilities,
      publicIp: opts.publicIp,
      // Only the agent knows the box's LAN address; keep whatever we had if an
      // older agent does not report one.
      localIp: opts.info.localIp ?? undefined,
      manufacturer: opts.info.manufacturer ?? undefined,
      model: opts.info.model ?? undefined,
      androidVersion: opts.info.androidVersion ?? undefined,
      sdkInt: opts.info.sdkInt ?? undefined,
      abi: opts.info.abi ?? undefined,
    },
  });
  bus.publish({ kind: "device", deviceId });
}

export async function markOffline(deviceId: string) {
  await prisma.device
    .update({ where: { id: deviceId }, data: { status: "OFFLINE" } })
    .catch(() => undefined);
  // Whatever the box last said about itself is now stale by definition, and a
  // monitor rule acting on it would be acting on the past.
  forgetReading(deviceId);
  bus.publish({ kind: "device", deviceId });
}

export async function applyMetrics(deviceId: string, metrics: DeviceMetrics) {
  // Only the agent knows whether it sent the whole inventory or just the
  // tracked apps, and it says so. Counting packages would be wrong the moment
  // a second app is tracked.
  const isInventory = metrics.packagesComplete === true;

  await prisma.device.update({
    where: { id: deviceId },
    data: {
      lastSeenAt: new Date(),
      status: "ONLINE",
      freeBytes: toBigInt(metrics.freeBytes),
      totalBytes: toBigInt(metrics.totalBytes),
      uptimeSeconds: metrics.uptimeSeconds ?? null,
      // Undefined rather than null when absent: an older agent that does not
      // send these must not wipe what a newer one already reported.
      loadAvg1: metrics.loadAvg1 ?? undefined,
      loadAvg5: metrics.loadAvg5 ?? undefined,
      loadAvg15: metrics.loadAvg15 ?? undefined,
      cpuCount: metrics.cpuCount ?? undefined,
      memTotalBytes: toBigInt(metrics.memTotalBytes) ?? undefined,
      memAvailableBytes: toBigInt(metrics.memAvailableBytes) ?? undefined,
      cpuTempC: metrics.cpuTempC ?? undefined,
      batteryTempC: metrics.batteryTempC ?? undefined,
      ...(isInventory ? { packagesSyncedAt: new Date() } : {}),
      // Only stamped when the box actually ran a monitor spec. An agent too
      // old to know about monitoring leaves both alone, which is what tells
      // the dashboard it cannot be counted as capable — and what stops the
      // rules that need it from reading its silence as a fault.
      ...(metrics.monitorRan
        ? {
            monitorReportedAt: new Date(),
            // Empty means the launcher is up, which is a real answer worth
            // storing, so this is deliberately not `?? undefined`.
            foregroundPackage: metrics.foregroundPackage || null,
          }
        : {}),
    },
  });

  // The live half of the same reading — the checks and the ANR list, which are
  // "how is this box right now" rather than history, and are replaced on every
  // beat rather than written to a row.
  recordReading(deviceId, metrics);

  // The row above is only ever "now". This is the history behind it, kept on
  // its own interval rather than one row per beat.
  await recordSample(deviceId, metrics);

  // Every box in the fleet beats every 20 seconds, so this runs constantly:
  // read the rows once and write only the ones that actually changed, rather
  // than firing an upsert per package per beat.
  const existing = await prisma.devicePackage.findMany({
    where: { deviceId },
    select: { packageName: true, versionName: true, versionCode: true, installed: true },
  });
  const current = new Map(existing.map((row) => [row.packageName, row]));

  for (const pkg of metrics.packages) {
    const versionCode = toBigInt(pkg.versionCode);
    const was = current.get(pkg.packageName);

    // The inventory has no versionName — only `pm list` ran, not dumpsys — so
    // a missing one keeps whatever the tracked read last established.
    const versionName = pkg.versionName ?? was?.versionName ?? null;

    if (
      was &&
      was.versionName === versionName &&
      was.versionCode === (versionCode ?? was.versionCode) &&
      was.installed === pkg.installed
    ) {
      continue;
    }

    const data = {
      versionName,
      versionCode: versionCode ?? was?.versionCode ?? null,
      installed: pkg.installed,
    };
    await prisma.devicePackage.upsert({
      where: { deviceId_packageName: { deviceId, packageName: pkg.packageName } },
      update: data,
      create: { deviceId, packageName: pkg.packageName, ...data },
    });
  }

  // Something the box no longer has is worth showing as gone, but only an
  // inventory is evidence of that.
  if (isInventory) {
    const reported = new Set(metrics.packages.map((p) => p.packageName));
    const vanished = existing
      .filter((row) => row.installed && !reported.has(row.packageName))
      .map((row) => row.packageName);

    if (vanished.length > 0) {
      await prisma.devicePackage.updateMany({
        where: { deviceId, packageName: { in: vanished } },
        data: { installed: false },
      });
    }
  }

  bus.publish({ kind: "device", deviceId });
}

/**
 * Safety net for sockets that die without a close frame — a box losing power
 * mid-heartbeat leaves the TCP connection hanging until the OS times it out.
 */
export async function sweepOffline(timeoutSeconds: number) {
  const cutoff = new Date(Date.now() - timeoutSeconds * 1000);
  const stale = await prisma.device.findMany({
    where: { status: "ONLINE", OR: [{ lastSeenAt: { lt: cutoff } }, { lastSeenAt: null }] },
    select: { id: true },
  });
  if (stale.length === 0) return 0;

  await prisma.device.updateMany({
    where: { id: { in: stale.map((d) => d.id) } },
    data: { status: "OFFLINE" },
  });
  for (const d of stale) bus.publish({ kind: "device", deviceId: d.id });
  log.info({ count: stale.length }, "marked devices offline");
  return stale.length;
}

/**
 * Packages the agent should report on every heartbeat.
 *
 * Two sources: the apps Magnemite updates, and the MITM each device group runs
 * — which nothing here polls a feed for, but whose version is worth seeing
 * across the fleet.
 *
 * The MITM list is the union of every group's, not each box's own. Sending a
 * box only its group's MITM looks tidier and is wrong: a box moved between
 * groups would stop reporting the one it actually has, and its old cell would
 * sit there stale forever. The union is also how a box in the wrong group is
 * spotted at all.
 */
export async function trackedPackages(): Promise<string[]> {
  const [targets, groups] = await Promise.all([
    prisma.appTarget.findMany({ where: { enabled: true }, select: { packageName: true } }),
    prisma.deviceGroup.findMany({
      where: { mitmPackageName: { not: null } },
      select: { mitmPackageName: true },
    }),
  ]);
  return [
    ...new Set([
      ...targets.map((row) => row.packageName),
      ...groups.map((row) => row.mitmPackageName as string),
    ]),
  ];
}

/**
 * Push a fresh `welcome` to every box that is connected.
 *
 * Two things ride in it that an agent otherwise only learns when it connects:
 * the tracked package list, and what to monitor. Without this a package added
 * in Settings would stay empty in the fleet table, and a monitor rule switched
 * on would do nothing, until each box happened to reconnect. The agent takes a
 * `welcome` at any point and replaces both with it.
 *
 * The monitor spec is per box rather than per fleet, because a rule can be
 * scoped to a device group.
 */
export async function broadcastWelcome(): Promise<number> {
  const [packages, rules, settings] = await Promise.all([
    trackedPackages(),
    loadEnabledRules(),
    getHubSettings(),
  ]);
  // `kind` is selected because the monitor spec depends on it: a host must be
  // sent the host rules, not the box ones. Hosts are otherwise welcomed
  // exactly like boxes -- same message, same heartbeat, same tracked packages
  // (which they simply have none of).
  const devices = await prisma.device.findMany({
    where: { id: { in: onlineDeviceIds() } },
    select: { id: true, name: true, approved: true, groupId: true, kind: true },
  });

  let sent = 0;
  for (const device of devices) {
    const ok = sendTo(device.id, {
      type: "welcome",
      deviceId: device.id,
      name: device.name,
      approved: device.approved,
      heartbeatSeconds: settings.heartbeatSeconds,
      trackedPackages: packages,
      monitor: specFor(rules, device.groupId, device.kind),
    });
    if (ok) sent += 1;
  }

  log.info({ sent, packages, rules: rules.length }, "welcome pushed to the fleet");
  return sent;
}
