"use client";

import { useMemo } from "react";
import { CircleCheck, CircleX } from "lucide-react";
import type { RotomWorkerView } from "@/lib/hub";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  TableSortHead,
} from "@/components/ui/table";
import { TablePaginationBar } from "@/components/ui/table-pagination";
import { RelativeTime } from "@/components/relative-time";
import { useTablePagination } from "@/lib/table-pagination";
import { useTableSort } from "@/lib/table-sort";

/**
 * The workers behind a box's numbers.
 *
 * Rendered from what the page already loaded, with no fetching of its own. The
 * hub keeps the last fleet sync's worker rows in memory and hands them over;
 * the sync had them anyway, since it asks for `include_workers=true` to compute
 * the request rate on the card beside this.
 *
 * It used to read them live, one box at a time, whenever the page re-rendered.
 * That was a call to Rotom driven by a page being open — and this page
 * re-renders on the fleet's own event feed, so during a rollout it was up to
 * one call a second over events about other boxes entirely. Rotom's own
 * dashboard never had that problem because it never had the second read: it
 * polls once and every view selects out of the same response.
 *
 * The cost is that the table is as of the last sync rather than as of now,
 * which the header says out loud instead of claiming to be live.
 *
 * Sorted and paged like the fleet and version tables, and for the reason those
 * are: a box with eight workers is a list, a box with fifty is a table, and the
 * second one is unreadable without a way to order it and a floor under how much
 * of it lands on screen at once.
 */
type SortKey =
  | "worker"
  | "version"
  | "inUse"
  | "rate1m"
  | "rate5m"
  | "ms"
  | "controller"
  | "userAgent"
  | "account";

export function DeviceRotomWorkers({
  workers,
  readAt,
  error,
  className,
}: {
  workers: RotomWorkerView[];
  /** When the sync that saw these ran. Null means it has not reached the box. */
  readAt: number | null;
  /** Set when the hub could not be reached at all. */
  error?: string | null;
  className?: string;
}) {
  const accessors = useMemo(
    () => ({
      // `compareValues` collates numerically, so `POKELX01-10` lands after
      // `POKELX01-9` rather than between the ones and the twos — the same order
      // the hub hands them over in.
      worker: (w: RotomWorkerView) => w.id,
      version: (w: RotomWorkerView) => w.version_name ?? null,
      inUse: (w: RotomWorkerView) => Boolean(w.is_in_use),
      rate1m: (w: RotomWorkerView) => w.time_windowed_stats?.requests_rate_over_1_min ?? null,
      rate5m: (w: RotomWorkerView) => w.time_windowed_stats?.requests_rate_over_5_min ?? null,
      ms: (w: RotomWorkerView) => w.time_windowed_stats?.request_ms_avg_over_5_min ?? null,
      controller: (w: RotomWorkerView) => w.session?.controller?.id ?? null,
      userAgent: (w: RotomWorkerView) => w.session?.controller?.user_agent ?? null,
      account: (w: RotomWorkerView) => w.session?.controller?.account_username ?? null,
    }),
    [],
  );

  const { headProps, sortRows } = useTableSort<SortKey, RotomWorkerView>(accessors, {
    key: "worker",
    direction: "asc",
  });
  const sorted = useMemo(() => sortRows(workers), [sortRows, workers]);
  // No `resetKey`: the rows are replaced on every sync, and jumping back to
  // page one every ten seconds would make the later pages unreadable. The hook
  // clamps the page on its own when the list shrinks.
  // Ten, not the hook's 25: this table sits beside another card rather than
  // filling a page, and a box's worker count is usually near it anyway.
  const pagination = useTablePagination(sorted, { pageSize: 10 });

  return (
    <Card className={className}>
      <CardHeader className="flex-row items-baseline justify-between gap-2 space-y-0">
        <CardTitle className="text-sm">Workers</CardTitle>
        <span className="text-xs text-muted-foreground">
          {readAt === null ? (
            "no reading yet"
          ) : (
            // Ticking, because the whole point of the label is how old this is.
            <>
              as of <RelativeTime value={new Date(readAt).toISOString()} live />
            </>
          )}
        </span>
      </CardHeader>

      <CardContent className="pt-0">
        {error ? (
          <p className="py-6 text-sm leading-relaxed text-muted-foreground">
            Could not read the workers: {error}
          </p>
        ) : readAt === null ? (
          <p className="py-6 text-sm text-muted-foreground">
            Nothing read yet — the next Rotom sync fills this in.
          </p>
        ) : workers.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">Rotom has no workers on this box.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <Table containerClassName="lg:max-h-[62vh]">
              <TableHeader>
                {/* No Platform column: it is a protobuf enum whose zero value is
                    UNSET, and a MITM that does not fill the field in its welcome
                    — Cosmog, for one — reads as UNSET on every worker forever. A
                    column that says the same nothing on every row is a column
                    that costs width. The controller's id and user agent take its
                    place: which thing is driving this worker, and which build. */}
                <TableRow>
                  <TableSortHead {...headProps("worker")}>Worker</TableSortHead>
                  <TableSortHead {...headProps("version")}>Version</TableSortHead>
                  <TableSortHead {...headProps("inUse")} align="center">
                    In use
                  </TableSortHead>
                  <TableSortHead {...headProps("rate1m")} align="right">
                    req/s 1m
                  </TableSortHead>
                  <TableSortHead {...headProps("rate5m")} align="right">
                    req/s 5m
                  </TableSortHead>
                  <TableSortHead {...headProps("ms")} align="right">
                    avg ms
                  </TableSortHead>
                  <TableSortHead {...headProps("controller")}>Controller</TableSortHead>
                  <TableSortHead {...headProps("userAgent")}>User agent</TableSortHead>
                  <TableSortHead {...headProps("account")}>Account</TableSortHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagination.rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                      Nothing on this page.
                    </TableCell>
                  </TableRow>
                ) : (
                  pagination.rows.map((worker) => {
                    const stats = worker.time_windowed_stats;
                    const controller = worker.session?.controller;
                    return (
                      <TableRow key={worker.id}>
                        <TableCell className="font-mono text-xs">{worker.id}</TableCell>
                        <TableCell>{worker.version_name ?? "—"}</TableCell>
                        <TableCell>
                          {/* The same tick and cross the flags on the card beside
                              this use, so one glance down the column counts the
                              allocated workers. Centred under a centred header,
                              since the mark is one glyph and has no edge to line
                              up against. The word stays for a screen reader,
                              which cannot see either mark. */}
                          <span className="flex justify-center">
                            {worker.is_in_use ? (
                              <CircleCheck className="h-4 w-4 text-success" aria-hidden="true" />
                            ) : (
                              <CircleX
                                className="h-4 w-4 text-muted-foreground"
                                aria-hidden="true"
                              />
                            )}
                            <span className="sr-only">{worker.is_in_use ? "yes" : "no"}</span>
                          </span>
                        </TableCell>
                        {/* tabular-nums here and not on the tiles: these are
                            columns that have to line up. */}
                        <TableCell className="text-right tabular-nums">
                          {rate(stats?.requests_rate_over_1_min)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {rate(stats?.requests_rate_over_5_min)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {typeof stats?.request_ms_avg_over_5_min === "number"
                            ? Math.round(stats.request_ms_avg_over_5_min)
                            : "—"}
                        </TableCell>
                        {/* All three are the controller's, and empty on a worker
                            Rotom is holding open with nothing allocated to it. */}
                        <TableCell className="font-mono text-xs">{controller?.id ?? "—"}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {controller?.user_agent ?? "—"}
                        </TableCell>
                        <TableCell>
                          {controller?.account_username
                            ? `${controller.account_username}${
                                controller.account_source ? ` (${controller.account_source})` : ""
                              }`
                            : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
            <TablePaginationBar pagination={pagination} unit="workers" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** A dash for a rate Rotom did not report, never a zero it never sent. */
function rate(value: number | null | undefined): string {
  return typeof value === "number" ? value.toFixed(2) : "—";
}
