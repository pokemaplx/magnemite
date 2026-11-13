import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, RadioTower, History } from "lucide-react";
import { CAPABILITY_SCREENSHOT, hasCapability } from "@magnemite/protocol";
import { prisma } from "@magnemite/db";
import { requireUser } from "@/lib/session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConnectivityBands } from "@/components/device-connectivity-bands";
import { loadConnectivityTrend } from "@/lib/connectivity";
import { actionPastLabel } from "@/lib/monitor-vocabulary";
import { OnlineDot } from "@/components/status";
import { DeviceControls } from "@/components/device-controls";
import { DeviceShortcuts } from "@/components/device-shortcuts";
import {
  DeviceHistory,
  type DeviceAgentUpdateRow,
  type DeviceJobRow,
} from "@/components/device-history";
import { DevicePackages, type DevicePackageRow } from "@/components/device-packages";
import { DeviceHeartbeat, DeviceLastSeen } from "@/components/device-last-seen";
import { DeviceLoadCard } from "@/components/device-load-card";
import { RelativeTime } from "@/components/relative-time";
import { loadRecentTrend } from "@/lib/metrics";
import { execMitm } from "@/lib/mitm-columns";
import { formatDuration, formatRelative } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function DevicePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  const [device, groups, targets, trend, connectivity] = await Promise.all([
    prisma.device.findUnique({
      where: { id },
      include: {
        group: true,
        // Set when the box is a Redroid container, which changes what removing
        // it means: the container is the machine's to destroy, not this row's.
        redroidInstance: { select: { id: true, hostId: true, index: true, present: true } },
        packages: { orderBy: { packageName: "asc" } },
        agentUpdates: {
          orderBy: { sentAt: "desc" },
          // Same idea as the job cap below: enough history to see a pattern,
          // not the whole life of the box.
          take: 50,
        },
        // "Why did this box reboot at 3am" is a question asked of one box, so
        // it needs answering here and not only fleet-wide in Settings.
        monitorEvents: { orderBy: { at: "desc" }, take: 20 },
        jobs: {
          orderBy: { queuedAt: "desc" },
          // The table pages client-side, so this is a cap on how far back the
          // history goes rather than on what fits on screen.
          take: 200,
          include: {
            rollout: {
              select: {
                id: true,
                appVersion: {
                  select: {
                    version: true,
                    appTarget: { select: { displayName: true, packageName: true } },
                  },
                },
              },
            },
          },
        },
      },
    }),
    prisma.deviceGroup.findMany({ orderBy: { name: "asc" } }),
    // Which of the installed packages Magnemite can actually update.
    prisma.appTarget.findMany({ where: { enabled: true }, select: { packageName: true } }),
    // The last hour behind each meter on the Load card.
    loadRecentTrend(id),
    // Two bands of the same hour: was the socket up, and were beats landing.
    loadConnectivityTrend(id),
  ]);

  if (!device) notFound();
  // A machine is a Device, so this page would render for one -- with a MITM
  // column, a scanner card and install controls that mean nothing on a VPS.
  // It has its own page; send it there rather than showing a box-shaped one.
  if (device.kind === "HOST") redirect(`/hosts/${device.id}`);

  const online = device.status === "ONLINE";
  // An expired window reads as not parked, before the hub's sweep has cleared
  // the column — the window is what the field means, not the row.
  const parked = device.maintenanceUntil !== null && device.maintenanceUntil.getTime() > Date.now();

  const jobRows: DeviceJobRow[] = device.jobs.map((job) => ({
    id: job.id,
    rolloutId: job.rolloutId,
    targetName: job.rollout.appVersion.appTarget.displayName,
    targetPackage: job.rollout.appVersion.appTarget.packageName,
    state: job.state,
    fromVersion: job.fromVersion,
    toVersion: job.toVersion,
    installMode: job.installMode,
    dataWiped: job.dataWiped,
    queuedAt: job.queuedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    durationMs:
      job.startedAt && job.finishedAt ? job.finishedAt.getTime() - job.startedAt.getTime() : null,
  }));

  const agentUpdateRows: DeviceAgentUpdateRow[] = device.agentUpdates.map((update) => ({
    id: update.id,
    fromVersion: update.fromVersion,
    toVersion: update.toVersion,
    state: update.state,
    error: update.error,
    sentAt: update.sentAt.toISOString(),
    finishedAt: update.finishedAt?.toISOString() ?? null,
  }));

  const tracked = new Set(targets.map((t) => t.packageName));
  const packageRows: DevicePackageRow[] = device.packages.map((pkg) => ({
    id: pkg.id,
    packageName: pkg.packageName,
    versionName: pkg.versionName,
    versionCode: pkg.versionCode === null ? null : pkg.versionCode.toString(),
    installed: pkg.installed,
    tracked: tracked.has(pkg.packageName),
  }));

  return (
    <div className="flex flex-col gap-5">
      <Link
        href="/"
        className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Fleet
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <OnlineDot online={online} />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{device.name}</h1>
            <p className="mt-1 font-mono text-xs text-muted-foreground">{device.serial}</p>
          </div>
          {!device.approved ? <Badge variant="warning">pending approval</Badge> : null}
          {/* The dot is green because the socket is genuinely there. This is
              the rest of the sentence: it is connected and has stopped saying
              anything, which the two-value status has no room for. */}
          {device.beatStaleSince ? (
            <Badge
              variant="warning"
              title={`Connected, but nothing since ${device.beatStaleSince.toLocaleString()}`}
            >
              not reporting
            </Badge>
          ) : null}
          {/* Next to the name rather than in a card, because it changes what
              every other control on this page will do. */}
          {parked ? (
            <Badge variant="info" title={`Until ${device.maintenanceUntil!.toLocaleString()}`}>
              in maintenance
            </Badge>
          ) : null}
        </div>

        {user.role !== "VIEWER" ? (
          <DeviceControls
            deviceId={device.id}
            name={device.name}
            approved={device.approved}
            online={online}
            groupId={device.groupId}
            groups={groups.map((g) => ({ id: g.id, name: g.name }))}
            maintenanceUntil={device.maintenanceUntil?.toISOString() ?? null}
            canScreenshot={hasCapability(device.capabilities, CAPABILITY_SCREENSHOT)}
            mitm={device.group ? execMitm(device.group) : null}
            instance={device.redroidInstance}
          />
        ) : null}
      </header>

      <DeviceShortcuts deviceId={device.id} current="overview" hasRotom={!!device.rotomDeviceId} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Hardware</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm">
            <Field
              label="Model"
              value={[device.manufacturer, device.model].filter(Boolean).join(" ") || "—"}
            />
            <Field label="Android" value={device.androidVersion ?? "—"} />
            <Field label="SDK" value={device.sdkInt?.toString() ?? "—"} />
            <Field label="ABI" value={device.abi ?? "—"} />
          </CardContent>
        </Card>

        <Card>
          {/* Same shape as the Agent and Load cards: the one control lives in
              the header, so the body stays entirely readings. */}
          <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-sm">State</CardTitle>
            <Button
              asChild
              variant="ghost"
              size="icon"
              className="-my-1 -mr-2 h-7 w-7"
              title="Connectivity history"
            >
              <Link href={`/devices/${device.id}/connectivity`} aria-label="Connectivity history">
                <History />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm">
            <Field label="Group" value={device.group?.name ?? "—"} />
            <Field
              label="Uptime"
              value={
                device.uptimeSeconds
                  ? formatDuration(new Date(Date.now() - device.uptimeSeconds * 1000), new Date())
                  : "—"
              }
            />
            <Field
              label="Last seen"
              value={
                <DeviceLastSeen
                  lastSeenAt={device.lastSeenAt?.toISOString() ?? null}
                  online={online}
                />
              }
            />
            {/* Same timestamp as above, read the other way: presence is what
                the row above answers, and this is how late the beat is. A box
                that says ONLINE while this climbs past the heartbeat interval
                is a box whose socket is open and whose agent is stuck. */}
            <Field
              label="Last heartbeat"
              value={<DeviceHeartbeat lastSeenAt={device.lastSeenAt?.toISOString() ?? null} />}
            />
            <ConnectivityBands trend={connectivity} beatStaleSince={device.beatStaleSince} />
          </CardContent>
        </Card>

        <Card>
          {/* Same shape as the Load card: the one control lives in the header,
              so the body stays entirely readings. */}
          <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-sm">Agent</CardTitle>
            {device.rotomDeviceId ? (
              <Button
                asChild
                variant="ghost"
                size="icon"
                className="-my-1 -mr-2 h-7 w-7"
                title="Scanner detail"
              >
                <Link href={`/devices/${device.id}/rotom`} aria-label="Scanner detail">
                  <RadioTower />
                </Link>
              </Button>
            ) : null}
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm">
            <Field label="Version" value={device.agentVersion ?? "—"} />
            {/* The socket's remote address is the reverse proxy on the hub's
                own network — the same 10.x on every box — so show the LAN
                address the agent reports, and fall back only for agents too
                old to send one. */}
            {device.localIp ? (
              <Field label="Local IP" value={device.localIp} />
            ) : (
              <Field label="Public IP" value={device.publicIp ?? "—"} />
            )}
            <Field label="Enrolled" value={formatRelative(device.createdAt)} />
            {/* One line only; everything else Rotom knows is behind the button
                in the header, which has room for the workers behind it. */}
            <Field
              label="Scanner (rotom)"
              value={
                device.rotomDeviceId
                  ? device.rotomConnected
                    ? "scanning"
                    : "not scanning"
                  : "not matched"
              }
            />
          </CardContent>
        </Card>

        <DeviceLoadCard
          load={{
            deviceId: device.id,
            loadAvg1: device.loadAvg1,
            loadAvg5: device.loadAvg5,
            loadAvg15: device.loadAvg15,
            cpuCount: device.cpuCount,
            memTotalBytes: device.memTotalBytes === null ? null : Number(device.memTotalBytes),
            memAvailableBytes:
              device.memAvailableBytes === null ? null : Number(device.memAvailableBytes),
            freeBytes: device.freeBytes === null ? null : Number(device.freeBytes),
            totalBytes: device.totalBytes === null ? null : Number(device.totalBytes),
          }}
          trend={trend}
        />
      </div>

      <DevicePackages
        packages={packageRows}
        syncedAt={device.packagesSyncedAt?.toISOString() ?? null}
      />

      {device.monitorEvents.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Automations</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {device.monitorEvents.map((event) => (
              <div
                key={event.id}
                className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-2 text-sm last:border-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <span>{event.message}</span>
                    {event.action ? (
                      <Badge variant={event.actionOk === false ? "danger" : "secondary"}>
                        {actionPastLabel(event.action)}
                        {event.actionOk === false ? " failed" : ""}
                      </Badge>
                    ) : null}
                  </p>
                  {event.detail ? (
                    <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                      {event.detail}
                    </p>
                  ) : null}
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  <RelativeTime value={event.at.toISOString()} />
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Update history</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DeviceHistory jobs={jobRows} agentUpdates={agentUpdateRows} />
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate text-right">{value}</span>
    </div>
  );
}
