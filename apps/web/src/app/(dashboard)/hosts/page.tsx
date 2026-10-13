import Link from "next/link";
import { getRedroidSettings, prisma } from "@magnemite/db";
import { requireUser } from "@/lib/session";
import { AddHostDialog } from "@/components/add-host-dialog";
import { DismissBootstrap } from "@/components/dismiss-bootstrap";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { OnlineDot } from "@/components/status";
import { RelativeTime } from "@/components/relative-time";
import { formatBytes } from "@/lib/format";

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
            select: { id: true, present: true, containerState: true, workers: true },
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

  const rows = hosts.map((host) => {
    // Only the instances that are *supposed* to be there. A removed one keeps
    // its row so re-adding the index brings the same box back, and counting it
    // would make a drained machine look broken.
    const wanted = host.redroidHost?.instances.filter((i) => i.present) ?? [];
    return {
      host,
      desired: wanted.length,
      running: wanted.filter((i) => i.containerState === "running").length,
      workers: wanted.reduce((sum, i) => sum + (i.workers ?? 0), 0),
      adopted: host.redroidHost?.adoptedAt ?? null,
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
        <div className="space-y-2 rounded-lg border p-4">
          <p className="text-sm font-medium">Being provisioned</p>
          {running.map((run) => {
            const steps = Array.isArray(run.steps)
              ? (run.steps as { name: string; ok: boolean; detail: string }[])
              : [];
            const failed = steps.find((step) => !step.ok);
            return (
              <div key={run.id} className="text-sm">
                <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
                  <span className="font-medium">{run.name}</span>{" "}
                  <span className="text-muted-foreground">{run.address}</span>
                  {" — "}
                  <span
                    className={
                      run.state === "FAILED" ? "text-destructive" : "text-muted-foreground"
                    }
                  >
                    {run.state === "RUNNING"
                      ? // The last step that printed is the honest answer to
                        // "where is it", and better than a percentage nobody can
                        // check.
                        (steps.at(-1)?.name ?? "starting") + "…"
                      : run.state === "WAITING"
                        ? "waiting for it to dial in"
                        : (failed?.name ?? "failed")}
                  </span>
                  {/* Nothing prunes these rows, so a failure stays here until
                      somebody says otherwise — which is right, and needs a way
                      to say it. A run still genuinely going is refused by the
                      action rather than hidden by the page. */}
                  {user.role !== "VIEWER" ? (
                    <span className="ml-auto flex items-center gap-2">
                      <DismissBootstrap id={run.id} name={run.name} />
                    </span>
                  ) : null}
                </div>
                {run.state === "FAILED" && run.error ? (
                  <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
                    {run.error}
                  </pre>
                ) : null}
              </div>
            );
          })}
        </div>
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
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Machine</TableHead>
                <TableHead align="right">Instances</TableHead>
                <TableHead align="right">Workers</TableHead>
                <TableHead align="right">CPU</TableHead>
                <TableHead>Memory</TableHead>
                <TableHead>Swap</TableHead>
                <TableHead>Disk</TableHead>
                <TableHead>Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ host, desired, running, workers, adopted }) => (
                <TableRow key={host.id}>
                  <TableCell>
                    <Link
                      href={`/hosts/${host.id}`}
                      className="flex items-center gap-2 font-medium"
                    >
                      <OnlineDot online={host.status === "ONLINE"} />
                      {host.name}
                    </Link>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {adopted === null ? "not adopted yet" : host.serial}
                    </div>
                  </TableCell>
                  <TableCell align="right" className="tabular-nums">
                    {/* running/desired, so a machine mid-converge reads as one
                        rather than as two numbers that disagree. */}
                    {desired === 0 ? "—" : `${running}/${desired}`}
                  </TableCell>
                  <TableCell align="right" className="tabular-nums">
                    {workers === 0 ? "—" : workers}
                  </TableCell>
                  <TableCell align="right" className="tabular-nums">
                    {/* Share of a single core, as everywhere else: 250 is two
                        and a half cores spent. */}
                    {host.cpuPercent === null ? "—" : `${Math.round(host.cpuPercent)}%`}
                  </TableCell>
                  <TableCell>{ofTotal(host.memAvailableBytes, host.memTotalBytes)}</TableCell>
                  <TableCell>{ofTotal(host.swapFreeBytes, host.swapTotalBytes)}</TableCell>
                  <TableCell>{ofTotal(host.freeBytes, host.totalBytes)}</TableCell>
                  <TableCell>
                    <RelativeTime value={host.lastSeenAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
