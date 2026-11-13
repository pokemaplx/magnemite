"use client";

import { useCallback, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BarChart3, Table2 } from "lucide-react";
import { RANGES, type Chart, type MetricsView, type RangeKey } from "@/lib/metrics-view";
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
import { cn } from "@/lib/utils";

const SERIES_BG: Record<number, string> = {
  1: "bg-chart-1",
  2: "bg-chart-2",
  3: "bg-chart-3",
  4: "bg-chart-4",
  5: "bg-chart-5",
  6: "bg-chart-6",
  7: "bg-chart-7",
  8: "bg-chart-8",
};

/** Charts that answer "what is this app costing me" rather than "how is the box". */
const PER_APP_CHARTS = new Set(["package-cpu", "package-memory"]);

export function DeviceMetrics({ view }: { view: MetricsView }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [asTable, setAsTable] = useState(false);

  // Filters live in the URL, not in state: a chart someone is looking at is
  // worth being able to paste into chat, and the server re-queries the window
  // rather than shipping the whole retention period to the browser.
  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) next.delete(key);
        else next.set(key, value);
      }
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const togglePackage = (name: string) => {
    const next = view.selected.includes(name)
      ? view.selected.filter((entry) => entry !== name)
      : [...view.selected, name];
    // An empty selection falls back to the default rather than to an empty
    // chart, so unticking the last one cannot leave the page blank.
    setParams({ packages: next.length > 0 ? next.join(",") : null });
  };

  const slotOf = (name: string) => view.packages.indexOf(name) + 1;

  return (
    <div className="flex flex-col gap-4">
      {/*
        One filter row, above everything it scopes — never per chart. Every
        chart below re-renders against the same window, so the numbers always
        agree with each other.
      */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {RANGES.map((range) => {
            // A preset longer than what the hub keeps would chart a window
            // that is mostly empty by definition.
            const beyondRetention = range.hours > view.retentionDays * 24;
            const active = rangeKey(searchParams.get("range")) === range.key;
            return (
              <Button
                key={range.key}
                size="sm"
                variant={active ? "secondary" : "ghost"}
                aria-pressed={active}
                disabled={beyondRetention}
                title={
                  beyondRetention
                    ? `Beyond the ${view.retentionDays}-day retention set in Settings`
                    : undefined
                }
                onClick={() => setParams({ range: range.key })}
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

      {view.packages.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Apps</span>
          {view.packages.map((name) => {
            const slot = slotOf(name);
            const active = view.selected.includes(name);
            // Past the eighth there is no palette slot left, and a generated
            // ninth hue would be indistinguishable from one already drawn.
            const unslotted = slot > 8;
            return (
              <Button
                key={name}
                size="sm"
                variant={active ? "secondary" : "outline"}
                aria-pressed={active}
                disabled={unslotted}
                title={unslotted ? "Only eight apps can be charted at once" : name}
                onClick={() => togglePackage(name)}
                className="font-mono text-[11px]"
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    active ? (SERIES_BG[slot] ?? SERIES_BG[1]) : "bg-muted-foreground/40",
                  )}
                />
                {name}
              </Button>
            );
          })}
        </div>
      ) : null}

      {view.charts.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {view.retentionDays <= 0
              ? "History recording is off — set a retention in Settings to start collecting."
              : "Nothing recorded in this window yet. The hub stores a sample every " +
                `${view.sampleSeconds}s while the box is online.`}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {view.charts.map((chart) => (
          <Card
            key={chart.id}
            className={cn(
              PER_APP_CHARTS.has(chart.id) && view.charts.length > 1 && "xl:col-span-2",
            )}
          >
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

      <p className="text-xs text-muted-foreground">
        {view.sampleCount.toLocaleString()} samples
        {/* No point claiming a bucket size for an empty window — there is
            nothing in it to have been bucketed. */}
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
  // Oldest-last, matching the chart's left-to-right, but scrolled to show the
  // recent end first is not worth the complexity — the header stays visible.
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
