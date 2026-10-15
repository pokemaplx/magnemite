import { prisma } from "@magnemite/db";
import { requireUser } from "@/lib/session";
import { compareVersions } from "@/lib/format";
import { mitmColumns } from "@/lib/mitm-columns";
import { FleetTable, type DeviceRow, type VersionOption } from "@/components/fleet-table";

export const dynamic = "force-dynamic";

const ACTIVE_OR_QUEUED = [
  "QUEUED",
  "DISPATCHED",
  "DOWNLOADING",
  "EXTRACTING",
  "INSTALLING",
  "VERIFYING",
] as const;

export default async function FleetPage() {
  const user = await requireUser();

  const target = await prisma.appTarget.findFirst({ where: { enabled: true, manual: false } });
  const packageName = target?.packageName ?? "com.nianticlabs.pokemongo";

  // The MITM columns come from the device groups: each one names the MITM its
  // boxes run. Read before the rest so their packages can be fetched alongside
  // the target's, keeping a device row at one query.
  const groups = await prisma.deviceGroup.findMany({ orderBy: { name: "asc" } });
  const columns = mitmColumns(groups);
  const mitmNames = columns.map((column) => column.packageName);

  const [devices, versions] = await Promise.all([
    prisma.device.findMany({
      // The Fleet table is the boxes. Machines have their own page, and a VPS
      // in here would show an empty MITM column, no scanner and no version
      // for every one of them.
      where: { kind: "BOX" },
      include: {
        group: { select: { id: true, name: true } },
        packages: { where: { packageName: { in: [packageName, ...mitmNames] } } },
        jobs: {
          where: { state: { in: [...ACTIVE_OR_QUEUED] } },
          orderBy: { queuedAt: "desc" },
          take: 1,
          select: { id: true, state: true, progress: true, rolloutId: true, toVersion: true },
        },
      },
      orderBy: [{ status: "asc" }, { name: "asc" }],
    }),
    // Every watched app, not just the primary one: a rollout picks its app in
    // the dialog, and only builds already cached here can be shipped.
    prisma.appVersion.findMany({
      where: { status: "READY", appTarget: { enabled: true, manual: false } },
      orderBy: { discoveredAt: "desc" },
      include: { appTarget: { select: { id: true, displayName: true, packageName: true } } },
    }),
  ]);

  const rows: DeviceRow[] = devices.map((device) => {
    const job = device.jobs[0];
    const installed = new Map(device.packages.map((pkg) => [pkg.packageName, pkg]));
    return {
      id: device.id,
      name: device.name,
      serial: device.serial,
      online: device.status === "ONLINE",
      approved: device.approved,
      maintenanceUntil: device.maintenanceUntil?.toISOString() ?? null,
      model: [device.manufacturer, device.model].filter(Boolean).join(" ") || null,
      androidVersion: device.androidVersion,
      agentVersion: device.agentVersion,
      groupName: device.group?.name ?? null,
      installedVersion: installed.get(packageName)?.versionName ?? null,
      mitmVersions: Object.fromEntries(
        mitmNames.map((name) => {
          const pkg = installed.get(name);
          // Uninstalled is not the same as never reported, and both read as an
          // empty cell — the count in Settings is where that distinction lives.
          return [name, pkg?.installed ? (pkg.versionName ?? null) : null];
        }),
      ),
      freeBytes: device.freeBytes === null ? null : Number(device.freeBytes),
      lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
      rotom: device.rotomDeviceId
        ? {
            connected: device.rotomConnected,
            workers: device.rotomWorkerCount,
            workersInUse: device.rotomWorkersInUse,
            enabled: device.rotomEnabled,
            requestRate: device.rotomRequestRate,
          }
        : null,
      job: job
        ? {
            id: job.id,
            rolloutId: job.rolloutId,
            state: job.state,
            progress: job.progress,
            toVersion: job.toVersion,
          }
        : null,
    };
  });

  const versionOptions: VersionOption[] = versions
    // Newest first within each app; the dialog groups by app, so ordering
    // across apps does not matter.
    .sort((a, b) => compareVersions(b.version, a.version))
    .map((v) => ({
      id: v.id,
      targetId: v.appTarget.id,
      targetName: v.appTarget.displayName,
      targetPackage: v.appTarget.packageName,
      version: v.version,
      source: v.source,
      sizeBytes: Number(v.sizeBytes),
      approved: v.approved,
    }));

  // The "outdated" filter compares against the app whose version the table's
  // own column shows, so this stays scoped to the primary target rather than
  // picking up whichever app happens to sort first.
  const latestVersion =
    versionOptions.find((option) => option.targetId === target?.id)?.version ?? null;

  return (
    <FleetTable
      rows={rows}
      groups={groups.map((g) => ({ id: g.id, name: g.name }))}
      versions={versionOptions}
      latestVersion={latestVersion}
      packageName={packageName}
      mitmColumns={columns}
      canOperate={user.role !== "VIEWER"}
    />
  );
}
