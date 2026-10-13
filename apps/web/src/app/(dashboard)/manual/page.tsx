import { prisma } from "@magnemite/db";
import { requireUser } from "@/lib/session";
import { mitmColumns } from "@/lib/mitm-columns";
import {
  ManualInstall,
  type FleetPackage,
  type ManualBuild,
  type ManualDevice,
} from "@/components/manual-install";

export const dynamic = "force-dynamic";

export default async function ManualPage() {
  const user = await requireUser();
  const canOperate = user.role !== "VIEWER";

  const [devices, groups, targets, builds, feedBuilds, uncachedFeed, packageCounts] =
    await Promise.all([
      prisma.device.findMany({
        // A manual install needs somewhere to install to. A host has no `pm`.
        where: { kind: "BOX", approved: true },
        include: {
          group: { select: { id: true, name: true } },
          // `installed: true` matters: a box that had the app and lost it keeps
          // its DevicePackage row with the last version it reported. Without the
          // filter the version column showed an app that is gone, and the box was
          // counted as an update rather than a fresh install.
          packages: {
            where: { installed: true },
            select: { packageName: true, versionName: true },
          },
        },
        orderBy: [{ status: "asc" }, { name: "asc" }],
      }),
      prisma.deviceGroup.findMany({ orderBy: { name: "asc" } }),
      prisma.appTarget.findMany({ orderBy: { displayName: "asc" } }),
      prisma.appVersion.findMany({
        where: { source: "MANUAL" },
        include: { appTarget: { select: { packageName: true, displayName: true } } },
        orderBy: { discoveredAt: "desc" },
        take: 100,
      }),
      // What the version sources already listed and cached, offered here as a
      // third way into a deploy.
      //
      // `READY` and nothing else, because that is exactly what `createRollout`
      // accepts -- it refuses anything without an artifact and a sha256, so a
      // DISCOVERED row in this list would be a choice that fails at submit.
      prisma.appVersion.findMany({
        where: { source: "MIRROR", status: "READY" },
        include: {
          appTarget: { select: { packageName: true, displayName: true } },
          feed: { select: { name: true } },
        },
        orderBy: { discoveredAt: "desc" },
        take: 100,
      }),
      // The ones a feed listed and has not cached. Counted rather than listed,
      // so the form can say why a version somebody is looking for is missing
      // instead of leaving them to conclude the feed is broken.
      prisma.appVersion.groupBy({
        by: ["appTargetId"],
        where: { source: "MIRROR", status: { not: "READY" } },
        _count: { _all: true },
      }),
      // What the boxes actually report having installed. The agent only reports
      // the packages the hub tracks, so this lists the watched app plus anything
      // that has been uploaded here before — and a package nobody has yet is
      // still reachable by typing its name.
      prisma.devicePackage.groupBy({
        by: ["packageName"],
        where: { installed: true, device: { approved: true } },
        _count: { _all: true },
      }),
    ]);

  const displayNames = new Map(targets.map((t) => [t.packageName, t.displayName]));
  const columns = mitmColumns(groups);
  const mitmPackages = new Set(columns.map((column) => column.packageName));

  const packages: FleetPackage[] = packageCounts
    .map((row) => ({
      packageName: row.packageName,
      displayName: displayNames.get(row.packageName) ?? null,
      devices: row._count._all,
      isMitm: mitmPackages.has(row.packageName),
    }))
    .sort((a, b) => b.devices - a.devices || a.packageName.localeCompare(b.packageName));

  // Targets with no install reported yet still belong in the picker.
  for (const target of targets) {
    if (!packages.some((p) => p.packageName === target.packageName)) {
      packages.push({
        packageName: target.packageName,
        displayName: target.displayName,
        devices: 0,
        isMitm: mitmPackages.has(target.packageName),
      });
    }
  }

  // The groups' MITMs, whether or not any box has reported one. This is the
  // fresh-install case: on a fleet that has just been flashed, the app you are
  // here to put on is precisely the one the census above cannot know about.
  for (const column of columns) {
    if (!packages.some((p) => p.packageName === column.packageName)) {
      packages.push({
        packageName: column.packageName,
        displayName: column.label,
        devices: 0,
        isMitm: true,
      });
    }
  }

  // MITMs first: on a fresh fleet the one app most needed is the one with the
  // fewest reported installs, which every other ordering buries.
  packages.sort((a, b) => Number(Boolean(b.isMitm)) - Number(Boolean(a.isMitm)));

  const deviceRows: ManualDevice[] = devices.map((device) => ({
    id: device.id,
    name: device.name,
    serial: device.serial,
    online: device.status === "ONLINE",
    groupId: device.group?.id ?? null,
    groupName: device.group?.name ?? null,
    model: [device.manufacturer, device.model].filter(Boolean).join(" ") || null,
    androidVersion: device.androidVersion,
    freeBytes: device.freeBytes === null ? null : Number(device.freeBytes),
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    installed: Object.fromEntries(
      device.packages
        .filter((p) => p.versionName)
        .map((p) => [p.packageName, p.versionName as string]),
    ),
  }));

  const buildRows: ManualBuild[] = builds.map((build) => ({
    id: build.id,
    packageName: build.appTarget.packageName,
    displayName: build.appTarget.displayName,
    version: build.version,
    arch: build.arch,
    sizeBytes: Number(build.sizeBytes),
    sha256: build.sha256,
    uploadedAt: build.discoveredAt.toISOString(),
    feed: null,
  }));

  // The same shape, so picking one of these and picking an upload are the same
  // thing downstream: both are an `appVersionId` and an ordinary rollout.
  const feedRows: ManualBuild[] = feedBuilds.map((build) => ({
    id: build.id,
    packageName: build.appTarget.packageName,
    displayName: build.appTarget.displayName,
    version: build.version,
    arch: build.arch,
    sizeBytes: Number(build.sizeBytes),
    sha256: build.sha256,
    uploadedAt: build.discoveredAt.toISOString(),
    feed: build.feed?.name ?? "a source",
  }));

  const packageById = new Map(targets.map((t) => [t.id, t.packageName]));
  const uncachedByPackage: Record<string, number> = {};
  for (const row of uncachedFeed) {
    const packageName = packageById.get(row.appTargetId);
    if (packageName) uncachedByPackage[packageName] = row._count._all;
  }

  return (
    <ManualInstall
      packages={packages}
      devices={deviceRows}
      groups={groups.map((g) => ({
        id: g.id,
        name: g.name,
        preInstallHook: g.preInstallHook,
        postInstallHook: g.postInstallHook,
        mitmPackageName: g.mitmPackageName,
        mitmConfigPath: g.mitmConfigPath,
        // Only for somebody who could edit it anyway. A scanner's config
        // holds its backend and often a key, and this page is readable by a
        // viewer — who has no override to seed and no deploy to seed it for.
        mitmConfig: canOperate ? g.mitmConfig : null,
      }))}
      builds={buildRows}
      feedBuilds={feedRows}
      uncachedByPackage={uncachedByPackage}
      mitmColumns={columns}
      canOperate={canOperate}
    />
  );
}
