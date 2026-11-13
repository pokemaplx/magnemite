import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CircleCheck, CircleX } from "lucide-react";
import { prisma } from "@magnemite/db";
import { requireUser } from "@/lib/session";
import { type RotomWorkerView, hub } from "@/lib/hub";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Meter } from "@/components/charts/meter";
import { Sparkline } from "@/components/charts/sparkline";
import { StateStrip } from "@/components/charts/state-strip";
import { OnlineDot } from "@/components/status";
import { DeviceRotomWorkers } from "@/components/device-rotom-workers";
import { DeviceShortcuts } from "@/components/device-shortcuts";
import { RelativeTime } from "@/components/relative-time";
import { RotomControls } from "@/components/rotom-controls";
import { RotomMetrics } from "@/components/rotom-metrics";
import { parseRange } from "@/lib/metrics-view";
import { SCANNER_LABEL, SCANNER_TITLE, SCANNER_VARIANT, scannerState } from "@/lib/rotom";
import {
  EMPTY_ROTOM_METRICS,
  EMPTY_ROTOM_TREND,
  loadRotomMetrics,
  loadRotomTrend,
} from "@/lib/rotom-trend";

export const dynamic = "force-dynamic";

/**
 * Everything Rotom says about one box, and the last hour of it.
 *
 * Its own route rather than a card on the device page, for the same reason the
 * load history has one: the device page answers "is this box alright", and the
 * answer to that is one line. This is the page you open when the line said
 * something you did not expect.
 *
 * The history is what makes it worth opening. "Not scanning" is a fact; "not
 * scanning for the last forty minutes, after three hours of scanning" is the
 * thing somebody can act on.
 */
export default async function DeviceRotomPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const query = await searchParams;

  const device = await prisma.device.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      serial: true,
      status: true,
      rotomDeviceId: true,
      rotomOrigin: true,
      rotomConnected: true,
      rotomEnabled: true,
      rotomCanBeUsed: true,
      rotomInUse: true,
      rotomWorkerCount: true,
      rotomWorkersInUse: true,
      rotomVersion: true,
      rotomRequestRate: true,
      rotomRequestMs: true,
      rotomStatWorkers: true,
      rotomLastSeenAt: true,
    },
  });
  if (!device) notFound();

  // Only for a matched box: there is no history of a box Rotom never saw, and
  // the queries would be a table scan for an empty answer.
  const [trend, metrics] = device.rotomDeviceId
    ? await Promise.all([
        loadRotomTrend(device.id),
        loadRotomMetrics(device.id, parseRange(query.range)),
      ])
    : [EMPTY_ROTOM_TREND, EMPTY_ROTOM_METRICS];

  // Loaded here rather than fetched by the table itself: the hub serves these
  // out of the last sync's memory, so there is nothing to wait for and no
  // reason to make the browser ask a second time. A hub that is down costs the
  // table, not the page.
  const live: { workers: RotomWorkerView[]; readAt: number | null; error?: string } =
    device.rotomDeviceId
      ? await hub.rotomWorkers(device.id).catch((err: unknown) => ({
          workers: [],
          readAt: null,
          error: err instanceof Error ? err.message : String(err),
        }))
      : { workers: [], readAt: null };

  const state = scannerState(
    device.rotomDeviceId
      ? {
          connected: device.rotomConnected,
          enabled: device.rotomEnabled,
          workers: device.rotomWorkerCount,
          workersInUse: device.rotomWorkersInUse,
          requestRate: device.rotomRequestRate,
        }
      : null,
  );

  const measured = device.rotomStatWorkers !== null && device.rotomRequestRate !== null;
  const workerPercent =
    device.rotomWorkersInUse === null || !device.rotomWorkerCount
      ? null
      : (device.rotomWorkersInUse / device.rotomWorkerCount) * 100;

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={`/devices/${device.id}`}
        className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {device.name}
      </Link>

      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <OnlineDot online={device.status === "ONLINE"} />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">Scanner (Rotom)</h1>
              <Badge variant={SCANNER_VARIANT[state]} title={SCANNER_TITLE[state]}>
                {SCANNER_LABEL[state]}
              </Badge>
            </div>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {device.serial}
              {device.rotomDeviceId ? ` · ${device.rotomDeviceId}` : ""}
            </p>
          </div>
        </div>
        {/* Refresh re-asks Rotom, rewrites the rows everything here is
            rendered from, and hands the worker table a new token to read on.
            The rest are the actions that travel Rotom's socket — a viewer gets
            neither, the same rule the device page's menu follows. */}
        {user.role !== "VIEWER" && device.rotomDeviceId ? (
          <RotomControls deviceId={device.id} name={device.name} enabled={device.rotomEnabled} />
        ) : null}
      </header>

      <DeviceShortcuts deviceId={device.id} current="rotom" hasRotom={!!device.rotomDeviceId} />

      {!device.rotomDeviceId ? (
        <Card>
          <CardContent className="py-8 text-sm leading-relaxed text-muted-foreground">
            No matching device in Rotom. Matching is on Rotom&apos;s own device id, against this
            box&apos;s name and then its serial — a box that never matches keeps working normally,
            it simply has no scanner state and no Rotom rule.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Tile
              label="Workers in use"
              value={
                device.rotomWorkersInUse === null || device.rotomWorkerCount === null
                  ? "—"
                  : `${device.rotomWorkersInUse} / ${device.rotomWorkerCount}`
              }
              detail={
                device.rotomWorkerCount === null
                  ? "Rotom did not say"
                  : `${device.rotomWorkerCount} attached to the box`
              }
            />
            <Tile
              label="Requests"
              value={measured ? `${device.rotomRequestRate}/s` : "—"}
              // Not zero: Rotom only counts request rates in `requests` mode, or
              // `proxy` with `inspect`, and a Rotom that does not count is
              // unknown rather than idle.
              detail={measured ? "across 5 minutes" : "not measured by this Rotom"}
              trend={trend.requestRate}
            />
            <Tile
              label="Average request"
              value={
                device.rotomRequestMs === null ? "—" : `${Math.round(device.rotomRequestMs)} ms`
              }
              detail={
                device.rotomRequestMs === null ? "no requests to average" : "across 5 minutes"
              }
              trend={trend.requestMs}
            />
            <Tile
              label="Last seen by Rotom"
              // Counting up on its own: the number only moves when the page
              // re-renders otherwise, so at a 10s sync it sat still and then
              // jumped, which reads as a stall rather than as nobody having
              // asked yet.
              value={<RelativeTime value={device.rotomLastSeenAt} live />}
              detail={device.rotomConnected ? "connection is open" : "no connection"}
            />
          </div>

          {/* A quarter and three quarters, not a third and two thirds: the card
              on the left is a fixed list of short fields and stops needing
              width, while the table has nine columns and two of them hold ids
              that wrap. */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-4">
            <Card className="xl:col-span-1">
              <CardHeader>
                <CardTitle className="text-sm">Rotom overview</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 pt-0 text-sm">
                <Meter
                  label="Workers in use"
                  value={
                    device.rotomWorkersInUse === null || device.rotomWorkerCount === null
                      ? "—"
                      : `${device.rotomWorkersInUse} of ${device.rotomWorkerCount}`
                  }
                  percent={workerPercent}
                  // Full is the point here, not the problem: every worker
                  // allocated is a box doing all the work it can.
                  tone="success"
                  detail={
                    workerPercent === null
                      ? "Rotom did not report a worker count"
                      : `${Math.round(workerPercent)}% of the workers attached`
                  }
                  trend={trend.workersInUse}
                />

                <div className="flex flex-col gap-2 border-t pt-4">
                  <Flag label="Connected" on={device.rotomConnected} trend={trend.connected} />
                  <Flag label="Enabled in Rotom" on={device.rotomEnabled} trend={trend.enabled} />
                  <Flag label="Can be used" on={device.rotomCanBeUsed} trend={trend.canBeUsed} />
                  <Flag label="In use" on={device.rotomInUse} trend={trend.inUse} />
                </div>

                <dl className="divide-y divide-border/60 border-t pt-1">
                  <Field label="Scanner version" value={device.rotomVersion ?? "—"} />
                  <Field label="Rotom device id" value={device.rotomDeviceId} mono />
                  <Field label="Origin" value={device.rotomOrigin ?? "—"} mono />
                </dl>
              </CardContent>
            </Card>

            <DeviceRotomWorkers
              workers={live.workers}
              readAt={live.readAt}
              error={live.error ?? null}
              className="xl:col-span-3"
            />
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            Everything above is as fresh as the last Rotom sync, on{" "}
            <Link href="/settings#tuning" className="underline hover:text-foreground">
              Settings → Tuning
            </Link>
            , and the bands beside the flags are the last hour of it.
          </p>

          <section className="flex flex-col gap-4 border-t pt-6">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">History</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                The same window and the same controls as the box&apos;s load history.
              </p>
            </div>
            <RotomMetrics view={metrics} />
          </section>
        </>
      )}
    </div>
  );
}

/**
 * One headline number.
 *
 * Proportional figures on purpose: `tabular-nums` gives every digit the width
 * of a zero, which reads loose at this size. It belongs in the worker table's
 * columns, where numbers have to line up, and not here.
 */
function Tile({
  label,
  value,
  detail,
  trend,
}: {
  label: string;
  value: ReactNode;
  detail: string;
  trend?: (number | null)[];
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 py-5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-2xl font-semibold leading-tight">{value}</span>
        <div className="flex items-end justify-between gap-2">
          <span className="text-xs text-muted-foreground">{detail}</span>
          {trend ? <Sparkline values={trend} /> : null}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * A yes/no with its last hour beside it.
 *
 * The tick or cross carries the answer and the label names it, so the colour is
 * never the only thing saying which way it went — and the band is the part
 * worth having: four flags that all read "no" look identical until you can see
 * that three have been no all hour and one went no eight minutes ago.
 */
function Flag({ label, on, trend }: { label: string; on: boolean; trend: (boolean | null)[] }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2">
        {on ? (
          <CircleCheck className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
        ) : (
          <CircleX className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
        )}
        <span className={on ? undefined : "text-muted-foreground"}>{label}</span>
        <span className="sr-only">{on ? "yes" : "no"}</span>
      </span>
      <StateStrip values={trend} />
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={mono ? "truncate text-right font-mono text-xs" : "text-right"}>{value}</dd>
    </div>
  );
}
