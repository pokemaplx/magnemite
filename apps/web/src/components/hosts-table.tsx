"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ConfigBehind,
  memoryUsed,
  stateOf,
  type InstanceRow,
} from "@/components/host-instances-table";
import { InstanceSetup } from "@/components/instance-setup";
import { OnlineDot } from "@/components/status";
import { RelativeTime } from "@/components/relative-time";
import { cn } from "@/lib/utils";

/** One container, as much of it as fits in a glance from the machine list. */
export type HostInstance = Pick<
  InstanceRow,
  | "id"
  | "index"
  | "serial"
  | "workers"
  | "ownWorkers"
  | "configBehind"
  | "containerState"
  | "device"
  | "setup"
> & {
  /** Whether the box inside it has its socket up, when it has enrolled. */
  online: boolean;
};

export type HostRow = {
  id: string;
  name: string;
  serial: string;
  online: boolean;
  adopted: boolean;
  /** Instances the machine should be running, and how many of them are. */
  desired: number;
  running: number;
  workers: number;
  cpuPercent: number | null;
  /** `free / total`, formatted on the server where the BigInts are. */
  memory: string;
  swap: string;
  disk: string;
  lastSeenAt: string | null;
  /** Only the ones supposed to be there, in index order. */
  instances: HostInstance[];
};

/**
 * The machine list, each machine with its containers listed under it.
 *
 * The question this page is asked most is "what is this machine running", and
 * it used to cost a page per machine to answer. Now the answer is open under
 * every machine from the start, and the arrow folds away the ones nobody is
 * looking at; the machine's own page stays where its instances are managed.
 */
export function HostsTable({ rows }: { rows: HostRow[] }) {
  // What has been folded away, rather than what is open, so everything starts
  // open -- a machine added while the page is up included. Not remembered
  // across visits: folding is tidying the page for now.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
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
          {rows.map((host) => {
            const expanded = host.instances.length > 0 && !collapsed.has(host.id);
            return (
              <Fragment key={host.id}>
                <TableRow>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-label={`${expanded ? "Hide" : "Show"} the containers on ${host.name}`}
                        disabled={host.instances.length === 0}
                        onClick={() => toggle(host.id)}
                        className="rounded p-0.5 text-muted-foreground hover:bg-subtle hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                      >
                        <ChevronRight
                          className={cn("h-4 w-4 transition-transform", expanded && "rotate-90")}
                        />
                      </button>
                      <Link
                        href={`/hosts/${host.id}`}
                        className="flex items-center gap-2 font-medium"
                      >
                        <OnlineDot online={host.online} />
                        {host.name}
                      </Link>
                    </div>
                    <div className="mt-0.5 pl-6 text-xs text-muted-foreground">
                      {host.adopted ? host.serial : "not adopted yet"}
                    </div>
                  </TableCell>
                  <TableCell align="right" className="tabular-nums">
                    {/* running/desired, so a machine mid-converge reads as one
                        rather than as two numbers that disagree. */}
                    {host.desired === 0 ? "—" : `${host.running}/${host.desired}`}
                  </TableCell>
                  <TableCell align="right" className="tabular-nums">
                    {host.workers === 0 ? "—" : host.workers}
                  </TableCell>
                  <TableCell align="right" className="tabular-nums">
                    {/* Share of a single core, as everywhere else: 250 is two
                        and a half cores spent. */}
                    {host.cpuPercent === null ? "—" : `${Math.round(host.cpuPercent)}%`}
                  </TableCell>
                  <TableCell>{host.memory}</TableCell>
                  <TableCell>{host.swap}</TableCell>
                  <TableCell>{host.disk}</TableCell>
                  <TableCell>
                    <RelativeTime value={host.lastSeenAt} />
                  </TableCell>
                </TableRow>

                {expanded ? (
                  <TableRow className="bg-subtle/40 hover:bg-subtle/40">
                    <TableCell colSpan={8} className="px-4 py-2">
                      <InstancesGlance instances={host.instances} />
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/** Read-only: removing and forgetting stay on the machine's own page. */
function InstancesGlance({ instances }: { instances: HostInstance[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead align="right" className="w-10">
            #
          </TableHead>
          <TableHead>Box</TableHead>
          <TableHead>Container</TableHead>
          <TableHead align="right">CPU</TableHead>
          <TableHead align="right">Memory</TableHead>
          <TableHead align="right">Workers</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {instances.map((row) => {
          const state = stateOf(row.containerState, row.device?.id ?? null);
          return (
            <TableRow key={row.id} className="border-0">
              <TableCell align="right" className="tabular-nums text-muted-foreground">
                {row.index}
              </TableCell>
              <TableCell>
                {row.device ? (
                  <Link
                    href={`/devices/${row.device.id}`}
                    className="flex items-center gap-2 font-medium"
                  >
                    <OnlineDot online={row.online} />
                    {row.device.name}
                  </Link>
                ) : (
                  <span className="font-mono text-xs text-muted-foreground">{row.serial}</span>
                )}
              </TableCell>
              <TableCell>
                {row.setup ? (
                  <InstanceSetup view={row.setup} />
                ) : (
                  <Badge variant={state.tone}>{state.label}</Badge>
                )}
              </TableCell>
              <TableCell align="right" className="tabular-nums">
                {row.device == null || row.device.cpuPercent === null
                  ? "—"
                  : `${Math.round(row.device.cpuPercent)}%`}
              </TableCell>
              <TableCell align="right" className="tabular-nums">
                {memoryUsed(row.device)}
              </TableCell>
              <TableCell align="right" className="tabular-nums">
                <div className="flex items-center justify-end gap-2">
                  {row.configBehind !== null ? <ConfigBehind was={row.configBehind} /> : null}
                  {/* Muted when inherited, as on the machine's own page, so
                      the containers with a number of their own stand out. */}
                  <span className={row.ownWorkers === null ? "text-muted-foreground" : ""}>
                    {row.workers}
                  </span>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
