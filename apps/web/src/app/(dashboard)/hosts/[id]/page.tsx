import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getRedroidSettings, planCapacity, prisma } from "@magnemite/db";
import { requireUser } from "@/lib/session";
import { HostScaleForm } from "@/components/host-scale-form";
import { HostInstancesTable } from "@/components/host-instances-table";
import { DeleteHost } from "@/components/delete-host";
import { HostSpendCard } from "@/components/host-spend-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DeviceLoadCard } from "@/components/device-load-card";
import { OnlineDot } from "@/components/status";
import { RelativeTime } from "@/components/relative-time";
import { formatBytes } from "@/lib/format";
import { instanceSetup, setupJobsSelect } from "@/lib/instance-setup-query";
import { loadRecentTrend } from "@/lib/metrics";

export const dynamic = "force-dynamic";

function num(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * One machine: what it is, what it is spending, and what it is running.
 *
 * The load card is the device one, unchanged — a host is a Device, so its
 * readings live in the same table and the same component draws them. Its
 * history button goes to `/devices/<id>/metrics`, which works for the same
 * reason.
 */
export default async function HostPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  const host = await prisma.device.findUnique({
    where: { id },
    include: {
      redroidHost: {
        include: {
          defaultGroup: { select: { id: true, name: true } },
          instances: {
            orderBy: { index: "asc" },
            include: {
              device: {
                select: {
                  id: true,
                  name: true,
                  status: true,
                  // What the container measured about itself. cpuPercent is
                  // its own cgroup's, which is the only CPU figure a box in a
                  // container actually has -- /proc/loadavg there is the whole
                  // machine's and says nothing about this one.
                  cpuPercent: true,
                  memTotalBytes: true,
                  memAvailableBytes: true,
                  // Its join installs, the last stage of a new one's setup.
                  jobs: setupJobsSelect(),
                },
              },
            },
          },
        },
      },
    },
  });

  // A box id here is a wrong turn rather than a missing page, but there is
  // nothing useful to show either way.
  if (!host || host.kind !== "HOST") notFound();

  const machine = host.redroidHost;
  // Written by the agent, so it is read defensively: a row from a hub that is
  // older than this column, or one somebody edited, must not throw the page.
  const bootstrapSteps = Array.isArray(machine?.bootstrapSteps)
    ? (machine.bootstrapSteps as { name: string; ok: boolean; detail: string }[])
    : [];
  // Asked for and not yet answered. The hub writes the time when it sends the
  // request and the verdict only when the machine reports, so these two
  // together are the only thing that separates "working" from "finished" —
  // and without saying so the page shows the last run's steps as if they were
  // this one's.
  const bootstrapRunning = machine?.bootstrapRanAt != null && machine.bootstrapOk === null;
  const [trend, redroid, groups] = await Promise.all([
    loadRecentTrend(host.id),
    getRedroidSettings(),
    // Which site a new container joins. Without this the enrolment falls back
    // to `default`, and the first rollout hands the box default's MITM config.
    prisma.deviceGroup.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  // Suggests, never decides. The memory half is a real ceiling — past it the
  // OOM killer takes boxes down instead of slowing them — and the CPU half is
  // a planning coefficient, so the form shows both and says which is which.
  // This machine's own ceiling when it has one, the fleet's when it does not.
  // The compose renderer has always resolved it this way (`instance ?? host ??
  // settings`); the capacity figure used to skip the middle term, so a tuned
  // machine was planned against a number none of its containers would get.
  const effectiveMemLimit = Number(machine?.memLimitBytes ?? redroid.memLimitBytes);
  const capacity = planCapacity(
    { ...redroid, memLimitBytes: effectiveMemLimit },
    host.cpuCount,
    host.memTotalBytes,
  );
  const wanted = machine?.instances.filter((i) => i.present) ?? [];
  // Every instance that ever enrolled, present or not: deleting the machine
  // deletes all of their Device rows, and a removed instance still has one.
  const enrolledBoxes = machine?.instances.filter((i) => i.deviceId).length ?? 0;
  const running = wanted.filter((i) => i.containerState === "running").length;
  const workers = wanted.reduce((sum, i) => sum + (i.workers ?? 0), 0);

  const facts: { label: string; value: string; node?: ReactNode }[] = [
    { label: "Architecture", value: machine?.arch ?? "—" },
    { label: "Kernel", value: machine?.kernel ?? "—" },
    { label: "Docker", value: machine?.dockerVersion ?? "—" },
    { label: "Cores", value: host.cpuCount === null ? "—" : String(host.cpuCount) },
    { label: "Memory", value: formatBytes(num(host.memTotalBytes)) },
    {
      // Zero is a real answer here and must not read as "has not said": a
      // machine with no swap is one the OOM killer reaches sooner, which is
      // worth seeing rather than hiding behind a dash.
      label: "Swap",
      value: host.swapTotalBytes === null ? "—" : formatBytes(num(host.swapTotalBytes)),
    },
    { label: "Agent", value: host.agentVersion ?? "—" },
    {
      // What the kernel row is for, answered: whether the setup has been run
      // against the kernel now booted. "never" is the honest answer for every
      // machine provisioned before this existed.
      label: "Setup last run",
      // A relative time, like every other time on these pages: a server
      // component's toLocaleString() renders the *server's* timezone, which on
      // a fleet run from another country is quietly the wrong hour.
      value: machine?.bootstrapRanAt == null ? "never since provisioning" : "",
      node:
        machine?.bootstrapRanAt == null ? null : (
          <>
            <RelativeTime value={machine.bootstrapRanAt} />{" "}
            <span className="text-muted-foreground">
              · {bootstrapRunning ? "running" : machine.bootstrapOk ? "ok" : "failed"}
            </span>
          </>
        ),
    },
    { label: "Serial", value: host.serial },
  ];

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/hosts"
        className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Machines
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <OnlineDot online={host.status === "ONLINE"} />
            {host.name}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {wanted.length === 0
              ? "No instances configured."
              : `${running}/${wanted.length} instances running · ${workers} workers`}
            {machine?.defaultGroup ? ` · new boxes join ${machine.defaultGroup.name}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {machine === null || machine.adoptedAt === null ? (
            <Badge variant="warning">not adopted</Badge>
          ) : null}
          {machine?.binderOk === false ? <Badge variant="danger">binder missing</Badge> : null}
          {user.role !== "VIEWER" ? (
            <DeleteHost
              hostId={host.id}
              name={host.name}
              instances={wanted.length}
              boxes={enrolledBoxes}
            />
          ) : null}
        </div>
      </div>

      {machine?.lastError ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Last failure</CardTitle>
          </CardHeader>
          <CardContent>
            {/* Pre-wrapped and scrollable: this is docker output, and the line
                that explains it is rarely the first one. */}
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
              {machine.lastError}
            </pre>
            <p className="mt-2 text-xs text-muted-foreground">
              <RelativeTime value={machine.lastErrorAt} />
            </p>
          </CardContent>
        </Card>
      ) : null}

      {bootstrapRunning || bootstrapSteps.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-baseline gap-2 text-sm">
              <span>
                {bootstrapRunning
                  ? "Setup running"
                  : `Last setup run · ${machine?.bootstrapOk ? "finished" : "failed"}`}
              </span>
              {/* When, always: steps with no date read as this minute's, and
                  three-week-old ones are the dangerous case. */}
              <span className="text-xs font-normal text-muted-foreground">
                <RelativeTime value={machine?.bootstrapRanAt ?? null} />
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* One line per `::step` the script printed, which is how a run
                that failed says which stage rather than just failing. */}
            {bootstrapRunning ? (
              <p className="mb-3 text-sm text-muted-foreground">
                Working. It takes a few minutes — apt, the kernel module, and an image build when
                the tag is one this machine does not have. The steps appear when it reports.
              </p>
            ) : null}
            {!bootstrapRunning && machine?.bootstrapOk ? (
              <p className="mb-3 text-sm text-muted-foreground">
                If this rebuilt the image, the containers are still on the old one until you{" "}
                <strong>Re-apply</strong>: the compose file did not change, so nothing recreates
                them by itself.
              </p>
            ) : null}
            <ol className="space-y-1 text-sm">
              {bootstrapSteps.map((step, index) => (
                <li key={`${step.name}-${index}`} className="flex items-baseline gap-2">
                  <span className={step.ok ? "text-success" : "text-destructive"}>
                    {step.ok ? "✓" : "✗"}
                  </span>
                  <span className="w-24 shrink-0 font-medium">{step.name}</span>
                  <span className="text-muted-foreground">{step.detail}</span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      ) : null}

      <HostScaleForm
        hostId={host.id}
        adopted={machine?.adoptedAt !== null && machine !== null}
        converging={machine?.convergingSince !== null && machine !== undefined}
        instances={wanted.length}
        workers={wanted[0]?.workers ?? null}
        memLimitBytes={machine?.memLimitBytes === null ? null : Number(machine?.memLimitBytes)}
        capacity={{
          byMemory: capacity.byMemory,
          byCpu: capacity.byCpu,
          suggested: capacity.suggested,
          workersPerInstance: redroid.workersPerInstance,
          // The CPU half's inputs, so the form can redo that division for the
          // workers actually typed into it — the server only ever knows the
          // number in Settings.
          cpuCount: host.cpuCount,
          workersPerVCpu: redroid.workersPerVCpu,
          // Named in the sentence that explains a suggestion of zero, which is
          // otherwise a dead end: these are fleet-wide and the machine is just
          // smaller than they assume.
          memLimitBytes: effectiveMemLimit,
          hostReserveBytes: redroid.hostReserveBytes,
          fleetMemLimitBytes: redroid.memLimitBytes,
          memTotalBytes: num(host.memTotalBytes),
        }}
        canOperate={user.role !== "VIEWER"}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Machine</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              {facts.map((fact) => (
                <div key={fact.label} className="contents">
                  <dt className="text-muted-foreground">{fact.label}</dt>
                  <dd className="truncate font-medium" title={fact.value}>
                    {fact.node ?? fact.value}
                  </dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>

        <DeviceLoadCard
          load={{
            deviceId: host.id,
            loadAvg1: host.loadAvg1,
            loadAvg5: host.loadAvg5,
            loadAvg15: host.loadAvg15,
            cpuCount: host.cpuCount,
            memTotalBytes: num(host.memTotalBytes),
            memAvailableBytes: num(host.memAvailableBytes),
            freeBytes: num(host.freeBytes),
            totalBytes: num(host.totalBytes),
          }}
          trend={trend}
        />
      </div>

      {/* The Load card above is the total; this is the same total taken
          apart, from readings that were already arriving. Between them they
          separate "one box is hot" from "this machine is busy with something
          that is not a box", which the page could not tell apart before. */}
      <HostSpendCard
        cpuCount={host.cpuCount}
        hostCpuPercent={host.cpuPercent}
        memTotalBytes={num(host.memTotalBytes)}
        memUsedBytes={
          host.memTotalBytes === null || host.memAvailableBytes === null
            ? null
            : num(host.memTotalBytes)! - num(host.memAvailableBytes)!
        }
        rows={wanted.map((instance) => ({
          index: instance.index,
          label: instance.device?.name ?? instance.serial,
          enrolled: instance.device !== null,
          cpuPercent: instance.device?.cpuPercent ?? null,
          memUsedBytes:
            instance.device?.memTotalBytes == null || instance.device?.memAvailableBytes == null
              ? null
              : num(instance.device.memTotalBytes)! - num(instance.device.memAvailableBytes)!,
        }))}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Instances</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <HostInstancesTable
            hostId={host.id}
            groups={groups}
            nameTemplate={machine?.nameTemplate ?? null}
            hostName={host.name}
            defaultGroupId={machine?.defaultGroupId ?? null}
            canOperate={user.role !== "VIEWER"}
            instances={wanted.map((instance) => ({
              id: instance.id,
              index: instance.index,
              serial: instance.serial,
              workers: instance.workers,
              containerState: instance.containerState,
              restartCount: instance.restartCount,
              // Serialised here: a Date cannot cross into a client component,
              // and the formatter takes either.
              reportedAt: instance.reportedAt?.toISOString() ?? null,
              device: instance.device
                ? {
                    id: instance.device.id,
                    name: instance.device.name,
                    cpuPercent: instance.device.cpuPercent,
                    memTotalBytes: num(instance.device.memTotalBytes),
                    memAvailableBytes: num(instance.device.memAvailableBytes),
                  }
                : null,
              setup: instanceSetup(instance, {
                name: host.name,
                status: host.status,
                convergingSince: machine?.convergingSince ?? null,
                lastError: machine?.lastError ?? null,
                lastErrorAt: machine?.lastErrorAt ?? null,
              }),
            }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
