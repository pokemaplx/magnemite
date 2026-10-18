import { prisma } from "@magnemite/db";
import { requireUser } from "@/lib/session";
import { RolloutsTable, type RolloutRow } from "@/components/rollouts-table";

export const dynamic = "force-dynamic";

export default async function RolloutsPage() {
  await requireUser();

  const rollouts = await prisma.rollout.findMany({
    include: {
      appVersion: {
        select: {
          version: true,
          source: true,
          appTarget: { select: { displayName: true, packageName: true } },
        },
      },
      createdBy: { select: { email: true, name: true } },
      jobs: { select: { state: true } },
      waitsFor: {
        select: {
          appVersion: { select: { version: true, appTarget: { select: { displayName: true } } } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const rows: RolloutRow[] = rollouts.map((rollout) => {
    const startedAt = rollout.startedAt ?? rollout.createdAt;
    return {
      id: rollout.id,
      targetName: rollout.appVersion.appTarget.displayName,
      targetPackage: rollout.appVersion.appTarget.packageName,
      version: rollout.appVersion.version,
      source: rollout.appVersion.source,
      status: rollout.status,
      waitingFor:
        rollout.status === "PENDING" && rollout.waitsFor
          ? `${rollout.waitsFor.appVersion.appTarget.displayName} ${rollout.waitsFor.appVersion.version}`
          : null,
      mode: rollout.mode,
      forceClean: rollout.forceClean,
      startedBy:
        rollout.mode === "AUTO"
          ? "auto-update"
          : (rollout.createdBy?.name ?? rollout.createdBy?.email ?? "—"),
      total: rollout.jobs.length,
      done: rollout.jobs.filter((j) => ["SUCCESS", "SKIPPED"].includes(j.state)).length,
      failed: rollout.jobs.filter((j) => j.state === "FAILED").length,
      startedAt: startedAt.toISOString(),
      // Precomputed so the "Duration" column can sort on a number rather than
      // on the formatted string.
      durationMs: rollout.finishedAt
        ? rollout.finishedAt.getTime() - startedAt.getTime()
        : rollout.startedAt
          ? Date.now() - startedAt.getTime()
          : null,
      finishedAt: rollout.finishedAt?.toISOString() ?? null,
    };
  });

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Rollouts</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every update run, manual or automatic. Open one to follow it device by device.
        </p>
      </header>

      <RolloutsTable rows={rows} />
    </div>
  );
}
