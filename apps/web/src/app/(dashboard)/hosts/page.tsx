import { getRedroidSettings, prisma, resolveWorkers } from "@magnemite/db";
import { requireUser } from "@/lib/session";
import { AddHostDialog } from "@/components/add-host-dialog";
import { BootstrapRuns, type BootstrapRun } from "@/components/bootstrap-runs";
import { HostsTable, type HostRow } from "@/components/hosts-table";
import { formatBytes } from "@/lib/format";
import { instanceSetup, setupJobsSelect } from "@/lib/instance-setup-query";
import { configBehind } from "@/lib/instance-workers";

export const dynamic = "force-dynamic";

/** Bytes come out of Prisma as BigInt; the formatter wants a number or null. */
function num(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

/** `free of total`, or a dash when the machine has not said. */
function ofTotal(free: bigint | null, total: bigint | null): string {
  if (free === null || total === null) return "—";
  return `${formatBytes(num(free))} / ${formatBytes(num(total))}`;
}

/**
 * The machines running Redroid containers.
 *
 * Its own page rather than a section of the fleet table, because the question
 * is different: the fleet table answers "which box needs attention", and this
 * answers "which machine does". A VPS has no scanner, no MITM and no installed
 * version, so it would be an empty row in every column over there.
 *
 * A host is a Device with `kind = HOST`, so everything here is the same query
 * the fleet runs with the discriminator flipped.
 */
export default async function HostsPage() {
  const user = await requireUser();

  const hosts = await prisma.device.findMany({
    where: { kind: "HOST" },
    include: {
      redroidHost: {
        include: {
          instances: {
            // Enough of each container for the arrow on its machine's row: the
            // box inside it, whether it is up, and what it is spending.
            select: {
              id: true,
              index: true,
              serial: true,
              present: true,
              containerState: true,
              workers: true,
              configWorkers: true,
              deviceId: true,
              requestedAt: true,
              device: {
                select: {
                  id: true,
                  name: true,
                  status: true,
                  cpuPercent: true,
                  memTotalBytes: true,
                  memAvailableBytes: true,
                  // Its join installs, the last stage of a new one's setup.
                  jobs: setupJobsSelect(),
                },
              },
            },
            orderBy: { index: "asc" },
          },
        },
      },
    },
    orderBy: [{ status: "asc" }, { name: "asc" }],
  });

  const [redroid, running, groups] = await Promise.all([
    getRedroidSettings(),
    // Machines being provisioned, which have no Device row yet -- that is the
    // whole reason the bootstrap has a table of its own. Shown here so a
    // twenty-minute run is visible rather than looking like nothing happened.
    prisma.redroidBootstrap.findMany({
      where: { state: { in: ["RUNNING", "WAITING", "FAILED"] } },
      orderBy: { startedAt: "desc" },
      take: 10,
    }),
    // For the group picker on the add dialog. The containers come up at the end
    // of provisioning and their boxes enrol straight into whatever this says,
    // so it is chosen before the run rather than after it.
    prisma.deviceGroup.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const runs: BootstrapRun[] = running.map((run) => ({
    id: run.id,
    name: run.name,
    address: run.address,
    // The query above reads only these three, which is what the narrowing says.
    state: run.state as BootstrapRun["state"],
    // `steps` is Json, which is the one shape both providers agree on -- so it
    // comes back as unknown and is narrowed here rather than trusted.
    steps: Array.isArray(run.steps) ? (run.steps as BootstrapRun["steps"]) : [],
    error: run.error,
    startedAt: run.startedAt.toISOString(),
  }));

  const rows: HostRow[] = hosts.map((host) => {
    // Only the instances that are *supposed* to be there. A removed one keeps
    // its row so re-adding the index brings the same box back, and counting it
    // would make a drained machine look broken.
    const wanted = host.redroidHost?.instances.filter((i) => i.present) ?? [];
    // Resolved per row, never read off a copy: own, else the machine's, else
    // Settings -- what each box's {{device.workers}} renders.
    const machineWorkers = host.redroidHost?.workers ?? null;
    const workersOf = (own: number | null) => resolveWorkers(own, machineWorkers, redroid);
    return {
      id: host.id,
      name: host.name,
      serial: host.serial,
      online: host.status === "ONLINE",
      adopted: (host.redroidHost?.adoptedAt ?? null) !== null,
      desired: wanted.length,
      running: wanted.filter((i) => i.containerState === "running").length,
      workers: wanted.reduce((sum, i) => sum + workersOf(i.workers), 0),
      cpuPercent: host.cpuPercent,
      memory: ofTotal(host.memAvailableBytes, host.memTotalBytes),
      swap: ofTotal(host.swapFreeBytes, host.swapTotalBytes),
      disk: ofTotal(host.freeBytes, host.totalBytes),
      lastSeenAt: host.lastSeenAt?.toISOString() ?? null,
      instances: wanted.map((instance) => ({
        id: instance.id,
        index: instance.index,
        serial: instance.serial,
        workers: workersOf(instance.workers),
        ownWorkers: instance.workers,
        configBehind: configBehind(instance, workersOf(instance.workers)),
        containerState: instance.containerState,
        online: instance.device?.status === "ONLINE",
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
          convergingSince: host.redroidHost?.convergingSince ?? null,
          lastError: host.redroidHost?.lastError ?? null,
          lastErrorAt: host.redroidHost?.lastErrorAt ?? null,
        }),
      })),
    };
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Machines</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The hosts running Redroid containers, and what each one is spending.
          </p>
        </div>
        {user.role !== "VIEWER" ? (
          <AddHostDialog defaultWorkers={redroid.workersPerInstance} groups={groups} />
        ) : null}
      </div>

      {running.length > 0 ? (
        <BootstrapRuns runs={runs} canOperate={user.role !== "VIEWER"} />
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">No machines yet</p>
          <p className="mx-auto mt-2 max-w-prose text-sm text-muted-foreground">
            Add one and it installs Docker, the binder module and the agent over a single SSH
            connection, then enrolls itself and brings up its containers. Nothing listens on the
            machine afterwards — it dials out, like a box.
          </p>
        </div>
      ) : (
        <HostsTable rows={rows} />
      )}
    </div>
  );
}
