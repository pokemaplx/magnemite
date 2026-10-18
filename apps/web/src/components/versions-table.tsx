"use client";

import { useMemo, useState, useTransition } from "react";
import { Check, Download, ExternalLink, Loader2, RefreshCw, Trash2, X } from "lucide-react";
import type { VersionSource, VersionStatus } from "@magnemite/db";
import { cacheVersion, pollSources, pruneVersions, setVersionApproval } from "@/actions/versions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { SearchInput } from "@/components/ui/search-input";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
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
import { VersionStatusBadge } from "@/components/status";
import { formatBytes } from "@/lib/format";
import { RelativeTime } from "@/components/relative-time";
import { useTablePagination } from "@/lib/table-pagination";
import { useTableSort } from "@/lib/table-sort";

type SortKey = "version" | "target" | "source" | "status" | "size" | "devices" | "published";

export type VersionRow = {
  id: string;
  /** Which app target this build belongs to — the fleet tracks several. */
  targetName: string;
  targetPackage: string;
  version: string;
  buildCode: string | null;
  source: VersionSource;
  /** Name of the feed that listed it. Null for manual uploads. */
  feedName: string | null;
  /** Where the artifact was fetched from; empty for an upload. */
  remoteUrl: string;
  arch: string;
  status: VersionStatus;
  cacheProgress: number;
  sizeBytes: number;
  approved: boolean;
  sha256: string | null;
  error: string | null;
  publishedAt: string | null;
  discoveredAt: string;
  devicesOnThis: number;
};

/**
 * Where a version came from, as somewhere a person can actually go.
 *
 * A source is whatever URL its index gave us, so the link is that URL and
 * nothing is special-cased per host. There is no listing page to send anyone
 * to — the entry *is* the file — and the tooltip says so before you click a
 * 170 MB download.
 */
function sourceLink(row: VersionRow): { href: string; hint: string } | null {
  if (!row.remoteUrl || row.source === "MANUAL") return null;

  const file = row.remoteUrl.split("/").pop() || "the file";
  return { href: row.remoteUrl, hint: `Download ${file}` };
}

/** The feed's own name, or what a manual upload is. */
function sourceLabel(row: VersionRow): string {
  if (row.source === "MANUAL") return "manual";
  return row.feedName ?? "unknown feed";
}

export function VersionsTable({
  rows,
  targetCount,
  canOperate,
}: {
  rows: VersionRow[];
  /** How many targets these versions span, for the count line. */
  targetCount: number;
  canOperate: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  // Which button is in flight, so only that one spins — `pending` is shared by
  // every action on this page, including the per-row Cache and Approve.
  const [running, setRunning] = useState<"poll" | "prune" | null>(null);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState("");

  const { headProps, sort, sortRows } = useTableSort<SortKey, VersionRow>(
    {
      version: (r) => r.version,
      // Grouping by app is what makes a multi-target list readable, so the
      // version is the tiebreak inside each one rather than a second sort.
      target: (r) => `${r.targetName}|${r.version}`,
      source: (r) => sourceLabel(r),
      status: (r) => r.status,
      size: (r) => r.sizeBytes,
      devices: (r) => r.devicesOnThis,
      published: (r) => r.publishedAt ?? r.discoveredAt,
    },
    { key: "published", direction: "desc" },
  );

  // Derived from the rows rather than passed in: the filter should only ever
  // offer apps that actually have a version here.
  const targets = useMemo(() => {
    const names = new Map<string, string>();
    for (const row of rows) names.set(row.targetPackage, row.targetName);
    return [...names.entries()]
      .map(([packageName, name]) => ({ packageName, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const matching = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byTarget = target ? rows.filter((row) => row.targetPackage === target) : rows;
    const filtered = q
      ? byTarget.filter(
          (row) =>
            row.version.toLowerCase().includes(q) ||
            row.targetName.toLowerCase().includes(q) ||
            row.targetPackage.toLowerCase().includes(q) ||
            sourceLabel(row).toLowerCase().includes(q) ||
            row.arch.toLowerCase().includes(q) ||
            row.status.toLowerCase().includes(q) ||
            (row.buildCode?.toLowerCase().includes(q) ?? false),
        )
      : byTarget;
    return sortRows(filtered);
  }, [rows, query, target, sortRows]);

  const pagination = useTablePagination(matching, {
    // Anything that reshuffles the list starts the reader at the top again;
    // a background refresh of the same list does not.
    resetKey: `${query}|${target}|${sort.key}|${sort.direction}`,
  });
  const visible = pagination.rows;
  const cached = rows.filter((r) => r.status === "READY").length;

  function run(fn: () => Promise<{ error?: string; message?: string }>, which?: "poll" | "prune") {
    setRunning(which ?? null);
    startTransition(async () => {
      const result = await fn();
      if (result?.error) toast(result.error, "error");
      else if (result?.message) toast(result.message);
      setRunning(null);
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Versions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {targetCount} app{targetCount === 1 ? "" : "s"} · {rows.length} known · {cached} cached
            on this server
          </p>
        </div>

        {canOperate ? (
          <div className="flex gap-2">
            {/* A poll reaches every feed before it answers, which can take a
                few seconds — long enough that a button which only greys out
                reads as broken. */}
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => run(pollSources, "poll")}
              className="min-w-[9.5rem]"
            >
              {running === "poll" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {running === "poll" ? "Checking…" : "Check sources"}
            </Button>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => run(() => pruneVersions(3), "prune")}
              className="min-w-[10.5rem]"
            >
              {running === "prune" ? <Loader2 className="animate-spin" /> : <Trash2 />}
              {running === "prune" ? "Freeing…" : "Free old bundles"}
            </Button>
          </div>
        ) : null}
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search version, app, build, source, arch…"
          className="max-w-md"
          shortcut
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
        <Table containerClassName="max-h-[62vh]">
          <TableHeader>
            <TableRow>
              <TableSortHead {...headProps("version")}>Version</TableSortHead>
              <TableSortHead {...headProps("target")}>Target</TableSortHead>
              <TableSortHead {...headProps("source")}>Source</TableSortHead>
              <TableSortHead {...headProps("status")}>On disk</TableSortHead>
              <TableSortHead {...headProps("size")} align="right">
                Size
              </TableSortHead>
              <TableSortHead {...headProps("devices")} align="right">
                Devices
              </TableSortHead>
              <TableSortHead {...headProps("published")}>Published</TableSortHead>
              <TableHead className="w-44" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                  No versions match this search.
                </TableCell>
              </TableRow>
            ) : null}
            {visible.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-medium">{row.version}</span>
                    {row.approved ? <Badge variant="success">approved</Badge> : null}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {row.buildCode ? `build ${row.buildCode} · ` : ""}
                    {row.arch}
                  </div>
                </TableCell>

                <TableCell className="min-w-36 text-sm">
                  <div className="truncate font-medium">{row.targetName}</div>
                  <div className="truncate font-mono text-xs text-muted-foreground">
                    {row.targetPackage}
                  </div>
                </TableCell>

                <TableCell className="text-sm text-muted-foreground">
                  <SourceCell row={row} />
                </TableCell>

                <TableCell className="min-w-40">
                  <div className="flex flex-col gap-1">
                    <VersionStatusBadge status={row.status} />
                    {row.status === "CACHING" ? <Progress value={row.cacheProgress} /> : null}
                    {row.error ? (
                      <span className="text-xs text-destructive" title={row.error}>
                        {row.error.slice(0, 60)}
                      </span>
                    ) : null}
                  </div>
                </TableCell>

                <TableCell className="text-right font-mono text-xs">
                  {formatBytes(row.sizeBytes)}
                </TableCell>

                <TableCell className="text-right font-mono text-xs">
                  {row.devicesOnThis > 0 ? row.devicesOnThis : "—"}
                </TableCell>

                <TableCell className="text-xs text-muted-foreground">
                  <RelativeTime value={row.publishedAt ?? row.discoveredAt} />
                </TableCell>

                <TableCell>
                  {canOperate ? (
                    <div className="flex justify-end gap-1">
                      {row.status !== "READY" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending || row.status === "CACHING"}
                          onClick={() => run(() => cacheVersion(row.id))}
                        >
                          <Download />
                          Cache
                        </Button>
                      ) : null}
                      {/* Fixed width: the label flips between two words of
                          different lengths, and without this the button — and
                          the Cache button beside it — resize on every click. */}
                      <Button
                        variant={row.approved ? "ghost" : "secondary"}
                        size="sm"
                        className="w-[6.5rem] justify-center"
                        disabled={pending}
                        onClick={() => run(() => setVersionApproval(row.id, !row.approved))}
                      >
                        {row.approved ? <X /> : <Check />}
                        {row.approved ? "Decline" : "Approve"}
                      </Button>
                    </div>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <TablePaginationBar pagination={pagination} unit="versions" />
      </div>

      <p className="text-xs text-muted-foreground">
        Approving a version only matters for auto-update, it is the gate the policy checks before
        starting a rollout on its own. Manual rollouts can pick any cached version.
      </p>
    </div>
  );
}

function SourceCell({ row }: { row: VersionRow }) {
  const link = sourceLink(row);

  if (!link) {
    return (
      <span title={row.source === "MANUAL" ? "Uploaded here — no upstream" : undefined}>
        {sourceLabel(row)}
      </span>
    );
  }

  return (
    <a
      href={link.href}
      target="_blank"
      rel="noreferrer"
      title={link.hint}
      className="group inline-flex items-center gap-1 hover:text-foreground hover:underline"
    >
      {sourceLabel(row)}
      <ExternalLink className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
    </a>
  );
}
