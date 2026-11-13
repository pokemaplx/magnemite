"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Rocket } from "lucide-react";
import type { RolloutStatus, VersionSource } from "@magnemite/db";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { SearchInput } from "@/components/ui/search-input";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSortHead,
} from "@/components/ui/table";
import { TablePaginationBar } from "@/components/ui/table-pagination";
import { RolloutStatusBadge } from "@/components/status";
import { formatDuration } from "@/lib/format";
import { RelativeTime } from "@/components/relative-time";
import { useTablePagination } from "@/lib/table-pagination";
import { useTableSort } from "@/lib/table-sort";

export type RolloutRow = {
  id: string;
  /** Which app this rollout shipped — the fleet tracks several. */
  targetName: string;
  targetPackage: string;
  version: string;
  source: VersionSource;
  status: RolloutStatus;
  /** What a PENDING rollout is waiting on, as "Pokémon GO 0.433.0". */
  waitingFor: string | null;
  mode: string;
  forceClean: boolean;
  startedBy: string;
  total: number;
  done: number;
  failed: number;
  startedAt: string;
  durationMs: number | null;
  finishedAt: string | null;
};

type SortKey =
  "version" | "target" | "status" | "progress" | "startedBy" | "startedAt" | "duration";

const OPEN_STATUSES: RolloutStatus[] = ["PENDING", "CANARY", "SOAKING", "RUNNING", "PAUSED"];

export function RolloutsTable({ rows }: { rows: RolloutRow[] }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [target, setTarget] = useState("");

  const { headProps, sort, sortRows } = useTableSort<SortKey, RolloutRow>(
    {
      version: (r) => r.version,
      // Grouping by app is what makes a multi-target list readable, so the
      // start time is the tiebreak inside each one rather than a second sort.
      target: (r) => `${r.targetName}|${r.startedAt}`,
      status: (r) => r.status,
      progress: (r) => (r.total === 0 ? 0 : (r.done + r.failed) / r.total),
      startedBy: (r) => r.startedBy,
      startedAt: (r) => r.startedAt,
      duration: (r) => r.durationMs,
    },
    { key: "startedAt", direction: "desc" },
  );

  // Derived from the rows rather than passed in: the filter should only ever
  // offer apps that actually have a rollout here.
  const targets = useMemo(() => {
    const names = new Map<string, string>();
    for (const row of rows) names.set(row.targetPackage, row.targetName);
    return [...names.entries()]
      .map(([packageName, name]) => ({ packageName, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const matching = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (target && row.targetPackage !== target) return false;
      if (status === "open" && !OPEN_STATUSES.includes(row.status)) return false;
      if (status && status !== "open" && row.status !== status) return false;
      if (!q) return true;
      return (
        row.version.toLowerCase().includes(q) ||
        row.targetName.toLowerCase().includes(q) ||
        row.targetPackage.toLowerCase().includes(q) ||
        row.source.toLowerCase().includes(q) ||
        row.status.toLowerCase().includes(q) ||
        row.startedBy.toLowerCase().includes(q)
      );
    });
    return sortRows(filtered);
  }, [rows, query, status, target, sortRows]);

  const pagination = useTablePagination(matching, {
    resetKey: `${query}|${status}|${target}|${sort.key}|${sort.direction}`,
  });
  const visible = pagination.rows;

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
          <Rocket className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No rollouts yet. Start one from the fleet page.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search app, version, status, who started it…"
          shortcut
        />
        <Select
          aria-label="Filter by status"
          placeholder="Select status…"
          value={status}
          onValueChange={setStatus}
          className="w-44"
          options={[
            { value: "", label: "All rollouts" },
            { value: "open", label: "Still running" },
            { value: "COMPLETED", label: "Completed" },
            { value: "PAUSED", label: "Paused" },
            { value: "CANCELLED", label: "Cancelled" },
          ]}
        />
        {/* Shown whenever there is anything to filter, not only once a second
            app exists — a control that appears the day a target is added is a
            control nobody knows is there. */}
        {targets.length > 0 ? (
          <Select
            aria-label="Filter by app target"
            placeholder="Select target…"
            value={target}
            onValueChange={setTarget}
            className="w-52"
            options={[
              { value: "", label: "All apps" },
              ...targets.map((t) => ({ value: t.packageName, label: t.name })),
            ]}
          />
        ) : null}
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <Table containerClassName="lg:max-h-[62vh]">
          <TableHeader>
            <TableRow>
              <TableSortHead {...headProps("version")}>Version</TableSortHead>
              <TableSortHead {...headProps("target")}>Target</TableSortHead>
              <TableSortHead {...headProps("status")}>Status</TableSortHead>
              <TableSortHead {...headProps("progress")} className="min-w-52">
                Progress
              </TableSortHead>
              <TableSortHead {...headProps("startedBy")}>Started by</TableSortHead>
              <TableSortHead {...headProps("startedAt")}>Started</TableSortHead>
              <TableSortHead {...headProps("duration")}>Duration</TableSortHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                  No rollouts match this search.
                </TableCell>
              </TableRow>
            ) : (
              visible.map((rollout) => {
                const pct =
                  rollout.total === 0 ? 0 : ((rollout.done + rollout.failed) / rollout.total) * 100;

                return (
                  <TableRow key={rollout.id}>
                    <TableCell>
                      <Link
                        href={`/rollouts/${rollout.id}`}
                        className="font-medium hover:underline"
                      >
                        {rollout.version}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {rollout.source.toLowerCase()}
                        {rollout.mode === "AUTO" ? " · automatic" : ""}
                        {rollout.forceClean ? " · clean install" : ""}
                      </div>
                    </TableCell>

                    <TableCell className="min-w-36 text-sm">
                      <div className="truncate font-medium">{rollout.targetName}</div>
                      <div className="truncate font-mono text-xs text-muted-foreground">
                        {rollout.targetPackage}
                      </div>
                    </TableCell>

                    <TableCell>
                      <RolloutStatusBadge status={rollout.status} />
                      {rollout.waitingFor ? (
                        <div className="mt-1 text-xs text-muted-foreground">
                          after {rollout.waitingFor}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>
                            {rollout.done}/{rollout.total} done
                          </span>
                          {rollout.failed > 0 ? (
                            <Badge variant="danger">{rollout.failed} failed</Badge>
                          ) : null}
                        </div>
                        <Progress value={pct} tone={rollout.failed > 0 ? "danger" : "primary"} />
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {rollout.startedBy}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <RelativeTime value={rollout.startedAt} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDuration(
                        new Date(rollout.startedAt),
                        rollout.finishedAt ? new Date(rollout.finishedAt) : null,
                      )}
                    </TableCell>
                    <TableCell>
                      <Link href={`/rollouts/${rollout.id}`} aria-label="Open rollout">
                        <ArrowRight className="h-4 w-4 text-muted-foreground" />
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
        <TablePaginationBar pagination={pagination} unit="rollouts" />
      </div>
    </div>
  );
}
