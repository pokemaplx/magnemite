"use client";

import { useCallback, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BarChart3, Table2 } from "lucide-react";
import { RANGES, type Chart, type RangeKey } from "@/lib/metrics-view";
import type { RotomMetricsView } from "@/lib/rotom-trend";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TimeSeriesChart, formatValue } from "@/components/charts/time-series-chart";

/**
 * The Rotom history, over a window someone chose.
 *
 * The same controls and the same charts as the load history, on purpose: a
 * reader should not have to learn that "Last 24 hours" means something
 * different one page over. What is missing next to that page is the package
 * filter, because there is nothing here to filter by — a box has one Rotom.
 */
export function RotomMetrics({ view }: { view: RotomMetricsView }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [asTable, setAsTable] = useState(false);

  // The window lives in the URL rather than in state: a chart someone is
  // looking at is worth being able to paste into chat, and the server
  // re-queries it rather than shipping the whole retention to the browser.
  const setRange = useCallback(
    (key: RangeKey) => {
      const next = new URLSearchParams(searchParams.toString());
      next.set("range", key);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const active = rangeKey(searchParams.get("range"));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {RANGES.map((range) => {
            // A preset longer than what the hub keeps would chart a window
            // that is mostly empty by definition.
            const beyondRetention = range.hours > view.retentionDays * 24;
            return (
              <Button
                key={range.key}
                size="sm"
                variant={active === range.key ? "secondary" : "ghost"}
                aria-pressed={active === range.key}
                disabled={beyondRetention}
                title={
                  beyondRetention
                    ? `Beyond the ${view.retentionDays}-day retention set in Settings`
                    : undefined
                }
                onClick={() => setRange(range.key)}
              >
                {range.label}
              </Button>
            );
          })}
        </div>

        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          aria-pressed={asTable}
          onClick={() => setAsTable((value) => !value)}
        >
          {asTable ? <BarChart3 /> : <Table2 />}
          {asTable ? "Charts" : "Table"}
        </Button>
      </div>

      {view.sampleCount === 0 ? (
        <Card>
          <CardContent className="py-8 text-sm leading-relaxed text-muted-foreground">
            Nothing recorded in this window yet. The hub keeps one reading per box every{" "}
            {view.sampleSeconds}s while the Rotom integration is on — it asks Rotom more often than
            that, but a chart does not need every answer — and holds them for {view.retentionDays}{" "}
            days.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {view.charts.map((chart) => (
            <Card key={chart.id}>
              <CardHeader>
                <CardTitle className="text-sm">{chart.title}</CardTitle>
                <p className="text-xs text-muted-foreground">{chart.description}</p>
              </CardHeader>
              <CardContent>
                {asTable ? (
                  <ChartTable chart={chart} times={view.times} />
                ) : (
                  <TimeSeriesChart chart={chart} times={view.times} />
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {view.sampleCount.toLocaleString()} readings
        {view.sampleCount > 0 ? ` · one point per ${formatBucket(view.bucketMs)}` : ""} · kept for{" "}
        {view.retentionDays}d
        {view.truncated ? " · window trimmed at the oldest end to stay within the row cap" : ""}
      </p>
    </div>
  );
}

function rangeKey(value: string | null): RangeKey {
  return (RANGES.find((range) => range.key === value)?.key ?? "24h") as RangeKey;
}

function formatBucket(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return `${Math.round(ms / 1000)}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

/** Every plotted value as text — the WCAG-clean twin of the chart above it. */
function ChartTable({ chart, times }: { chart: Chart; times: number[] }) {
  const rows = times
    .map((time, index) => ({
      time,
      values: chart.series.map((series) => series.points[index] ?? null),
    }))
    .filter((row) => row.values.some((value) => value !== null));

  return (
    <Table containerClassName="max-h-80 pointer-coarse:overscroll-y-none rounded-lg border border-border">
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          {chart.series.map((series) => (
            <TableHead key={series.id} className="text-right">
              {series.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.time}>
            <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
              {new Date(row.time).toLocaleString(undefined, {
                day: "2-digit",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </TableCell>
            {row.values.map((value, index) => (
              <TableCell key={index} className="text-right tabular-nums">
                {formatValue(value, chart.unit)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
