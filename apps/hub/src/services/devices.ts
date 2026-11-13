import type { deviceInfoSchema, deviceMetricsSchema } from "@magnemite/protocol";
import type { z } from "zod";
import { prisma } from "@magnemite/db";
import { closeEpisode, openEpisode } from "./connectivity.js";
import { getHubSettings } from "./hubSettings.js";
import { bus } from "../bus.js";
import { log } from "../log.js";
import { onlineDeviceIds, sendTo } from "../registry.js";
import { recordSample } from "./metrics.js";
import { forgetReading, loadEnabledRules, recordReading, specFor } from "./monitor.js";

type DeviceInfo = z.infer<typeof deviceInfoSchema>;
type DeviceMetrics = z.infer<typeof deviceMetricsSchema>;

/** Unix seconds from an agent, as a Date — or undefined, meaning "did not say". */
function secondsToDate(value: number | null | undefined): Date | undefined {
  if (value === null || value === undefined || value <= 0) return undefined;
  return new Date(value * 1000);
}

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
      // It is beating again, so whatever stall the sweep stamped is over.
      // Folded into the update that was happening anyway rather than given a
      // statement of its own, which is also what makes it impossible to forget.
      beatStaleSince: null,
      agentVersion: opts.agentVersion,
      // Replaced outright on every hello, empty list included: a rolled-back
      // agent has to stop claiming what it can no longer do.
      capabilities: opts.capabilities,
      publicIp: opts.publicIp,
      // `?? undefined`, like the readings below: an older agent that does not
      // send these must not wipe what a newer one established. Absence is the
      // signal here, exactly as it is for `monitorRan`.
      bootedAt: secondsToDate(opts.info.bootedAt),
      agentStartedAt: secondsToDate(opts.info.agentStartedAt),
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
    // Plainly offline now, so a stall stamp from the sweep is no longer the
    // right description of it: a box with no socket is not a mute one.
    .update({ where: { id: deviceId }, data: { status: "OFFLINE", beatStaleSince: null } })
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
      beatStaleSince: null,
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
      // The same `?? undefined` rule, and here it is what the agent's pointer
      // fields exist for: an idle machine sends a genuine 0 and a machine with
      // no swap sends a genuine 0 bytes, both of which have to land as zero
      // rather than be mistaken for an agent that did not say.
      cpuPercent: metrics.cpuPercent ?? undefined,
      swapTotalBytes: toBigInt(metrics.swapTotalBytes) ?? undefined,
      swapFreeBytes: toBigInt(metrics.swapFreeBytes) ?? undefined,
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
  // It is back. Nothing happens here on a healthy box — the check is a map
  // lookup against an empty map.
  void closeEpisode(deviceId);

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
 *
 * Silence past the timeout is two different faults wearing one symptom, and
 * whether we still hold the box's socket is the whole difference. This used to
 * ask only how long ago the row was written, so a connected box whose beat
 * merely ran late was flipped to OFFLINE — and flipped back by the next beat.
 * That pair, fired and recovered inside a minute with nothing having
 * disconnected, is the whole of the "Box unreachable" noise.
 */
export async function sweepOffline(timeoutSeconds: number) {
  const cutoff = new Date(Date.now() - timeoutSeconds * 1000);
  const stale = await prisma.device.findMany({
    where: { status: "ONLINE", OR: [{ lastSeenAt: { lt: cutoff } }, { lastSeenAt: null }] },
    select: { id: true, name: true, lastSeenAt: true, beatStaleSince: true },
  });
  if (stale.length === 0) return 0;

  // A row saying ONLINE is a record of the last write, not of the link. Only
  // the registry knows the link.
  const connected = new Set(onlineDeviceIds());
  const gone = stale.filter((d) => !connected.has(d.id));
  const mute = stale.filter((d) => connected.has(d.id));

  if (gone.length > 0) {
    await prisma.device.updateMany({
      where: { id: { in: gone.map((d) => d.id) } },
      data: { status: "OFFLINE" },
    });
    for (const d of gone) {
      bus.publish({ kind: "device", deviceId: d.id });
      // No close frame ever arrived — a box that lost power leaves the socket
      // hanging until the OS times it out — so this is the only place the
      // episode gets opened at all.
      void openEpisode(d.id);
    }
    log.info({ count: gone.length }, "marked devices offline");
  }

  // Reachable and mute. Deliberately no status write: the socket is there, and
  // calling that OFFLINE is what announced healthy boxes as unreachable. It is
  // stamped instead, so the dashboard can say what is actually wrong — and so
  // a rule can act on the box, which it can, because that socket still carries
  // exec, restart and reboot.
  //
  // One update per stall rather than one per sweep: already-stamped boxes are
  // filtered out, so a box that stays mute for an hour costs one write.
  for (const d of mute) {
    if (d.beatStaleSince !== null) continue;
    const since = d.lastSeenAt ?? cutoff;
    await prisma.device.update({
      where: { id: d.id },
      // The beat it went quiet after, not the moment we noticed, which is up
      // to a sweep interval later.
      data: { beatStaleSince: since },
    });
    bus.publish({ kind: "device", deviceId: d.id });
    // A stall is lost contact too, and it is the kind with no close code. If
    // it later degenerates into a real disconnection, the close handler fills
    // that code into this same row rather than opening a second one.
    void openEpisode(d.id);
    log.warn(
      {
        deviceId: d.id,
        device: d.name,
        quietForSeconds: Math.round((Date.now() - since.getTime()) / 1000),
      },
      "socket is open and the box has stopped beating",
    );
  }

  return gone.length;
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
