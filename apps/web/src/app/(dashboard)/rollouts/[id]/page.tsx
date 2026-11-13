import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { prisma } from "@magnemite/db";
import { requireUser } from "@/lib/session";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { RolloutStatusBadge } from "@/components/status";
import { RolloutActions, RolloutJobs, type JobRow } from "@/components/rollout-detail";
import { formatBytes, formatDuration } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function RolloutPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  const rollout = await prisma.rollout.findUnique({
    where: { id },
    include: {
      appVersion: { include: { appTarget: { select: { packageName: true } } } },
      createdBy: { select: { email: true, name: true } },
      waitsFor: {
        select: {
          id: true,
          appVersion: { select: { version: true, appTarget: { select: { displayName: true } } } },
        },
      },
      jobs: {
        include: {
          device: {
            select: { id: true, name: true, status: true, group: { select: { name: true } } },
          },
          events: { orderBy: { ts: "desc" }, take: 40 },
        },
        orderBy: [{ isCanary: "desc" }, { state: "asc" }],
      },
    },
  });

  if (!rollout) notFound();

  const counts = {
    total: rollout.jobs.length,
    success: rollout.jobs.filter((j) => j.state === "SUCCESS").length,
    failed: rollout.jobs.filter((j) => j.state === "FAILED").length,
    skipped: rollout.jobs.filter((j) => j.state === "SKIPPED").length,
    queued: rollout.jobs.filter((j) => j.state === "QUEUED").length,
    working: rollout.jobs.filter((j) =>
      ["DISPATCHED", "DOWNLOADING", "EXTRACTING", "INSTALLING", "VERIFYING"].includes(j.state),
    ).length,
  };

  const jobs: JobRow[] = rollout.jobs.map((job) => ({
    id: job.id,
    deviceId: job.device.id,
    deviceName: job.device.name,
    deviceOnline: job.device.status === "ONLINE",
    groupName: job.device.group?.name ?? null,
    state: job.state,
    progress: job.progress,
    isCanary: job.isCanary,
    attempt: job.attempt,
    lastError: job.lastError,
    dataWiped: job.dataWiped,
    installMode: job.installMode,
    fromVersion: job.fromVersion,
    toVersion: job.toVersion,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    events: job.events
      .slice()
      .reverse()
      .map((e) => ({
        ts: e.ts.toISOString(),
        level: e.level,
        phase: e.phase,
        message: e.message,
      })),
  }));

  const wiped = rollout.jobs.filter((j) => j.dataWiped).length;

  return (
    <div className="flex flex-col gap-5">
      <Link
        href="/rollouts"
        className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        All rollouts
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight">
              {rollout.appVersion.appTarget.packageName.split(".").pop()}{" "}
              {rollout.appVersion.version}
            </h1>
            <RolloutStatusBadge status={rollout.status} />
            {rollout.mode === "AUTO" ? <Badge variant="info">auto</Badge> : null}
            {rollout.forceClean ? <Badge variant="danger">clean install</Badge> : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {rollout.appVersion.source.toLowerCase()} ·{" "}
            {formatBytes(Number(rollout.appVersion.sizeBytes))} · started by{" "}
            {rollout.mode === "AUTO"
              ? "auto-update"
              : (rollout.createdBy?.name ?? rollout.createdBy?.email ?? "—")}{" "}
            · {formatDuration(rollout.startedAt, rollout.finishedAt)}
            {rollout.note ? ` · ${rollout.note}` : ""}
          </p>
        </div>

        {user.role !== "VIEWER" ? (
          <RolloutActions
            rolloutId={rollout.id}
            status={rollout.status}
            failedCount={counts.failed}
          />
        ) : null}
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Devices" value={counts.total} />
        <Stat label="Done" value={counts.success} tone="success" />
        <Stat label="Working" value={counts.working} tone="info" />
        <Stat label="Queued" value={counts.queued} />
        <Stat label="Failed" value={counts.failed} tone="danger" />
        <Stat label="Up to date" value={counts.skipped} />
      </div>

      {rollout.status === "PAUSED" ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          The canary failed, so the rest of the fleet was held back. Fix the problem and retry, or
          resume to push on anyway.
        </div>
      ) : null}

      {rollout.status === "PENDING" && rollout.waitsFor ? (
        <div className="rounded-md border border-border bg-subtle px-3 py-2 text-sm">
          Waiting for{" "}
          <Link href={`/rollouts/${rollout.waitsFor.id}`} className="font-medium hover:underline">
            {rollout.waitsFor.appVersion.appTarget.displayName}{" "}
            {rollout.waitsFor.appVersion.version}
          </Link>{" "}
          to install first. It starts on its own once that has; if it failed, retrying it there is
          what lets this one go — or start this now, without it.
        </div>
      ) : null}

      {rollout.status === "SOAKING" && rollout.canaryPassedAt ? (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          Canary succeeded. Holding the fleet for {rollout.soakMinutes} minutes before releasing the
          rest — resume to skip the wait.
        </div>
      ) : null}

      {wiped > 0 ? (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          {wiped} device{wiped === 1 ? "" : "s"} needed an uninstall to take this build, so their
          app data was wiped.
        </div>
      ) : null}

      <RolloutJobs jobs={jobs} rolloutId={rollout.id} canOperate={user.role !== "VIEWER"} />
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "success" | "danger" | "info";
}) {
  const color =
    tone === "success"
      ? "text-success"
      : tone === "danger"
        ? "text-destructive"
        : tone === "info"
          ? "text-info"
          : "";
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`font-mono text-2xl ${value > 0 ? color : ""}`}>{value}</div>
      </CardContent>
    </Card>
  );
}
