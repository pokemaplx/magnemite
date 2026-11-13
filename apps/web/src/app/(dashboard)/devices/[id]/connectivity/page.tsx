import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { prisma } from "@magnemite/db";
import { requireUser } from "@/lib/session";
import { CAUSE_DETAIL, CAUSE_LABELS, causeVariant, loadEpisodes } from "@/lib/connectivity";
import { DeviceConnectivity, type EpisodeRow } from "@/components/device-connectivity";
import { DeviceShortcuts } from "@/components/device-shortcuts";
import { IncidentWindow } from "@/components/incident-window";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

const WINDOWS: Record<string, { label: string; ms: number }> = {
  "24h": { label: "24 hours", ms: 24 * 60 * 60 * 1000 },
  "7d": { label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  "30d": { label: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
};

/**
 * Why this box went quiet, and when.
 *
 * A sibling of the scanner page rather than a tab on the device page, for the
 * reason that one is: the device page answers "is this box alright", and this
 * is the page you open when the answer was something you did not expect.
 */
export default async function ConnectivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ range?: string; at?: string }>;
}) {
  await requireUser();
  const { id } = await params;
  const query = await searchParams;

  const range = WINDOWS[query.range ?? "7d"] ? (query.range ?? "7d") : "7d";
  const device = await prisma.device.findUnique({
    where: { id },
    select: { id: true, name: true, serial: true, kind: true, rotomDeviceId: true },
  });
  if (!device) notFound();

  const episodes = await loadEpisodes(id, WINDOWS[range]!.ms);

  const closed = episodes.filter((e) => e.durationSeconds !== null);
  const totalDown = closed.reduce((sum, e) => sum + (e.durationSeconds ?? 0), 0);
  const longest = closed.reduce((max, e) => Math.max(max, e.durationSeconds ?? 0), 0);
  const reboots = episodes.filter((e) => e.cause === "REBOOT").length;
  const stalls = episodes.filter((e) => e.cause === "HEARTBEAT_STALL").length;

  const rows: EpisodeRow[] = episodes.map((e) => ({
    id: e.id,
    startedAt: e.startedAt.toISOString(),
    endedAt: e.endedAt?.toISOString() ?? null,
    durationSeconds: e.durationSeconds,
    cause: e.cause,
    causeLabel: e.cause ? CAUSE_LABELS[e.cause] : "still out of contact",
    causeDetail: e.cause ? CAUSE_DETAIL[e.cause] : "The box has not come back yet.",
    causeVariant: causeVariant(e.cause),
    closeCode: e.closeCode,
    closeReason: e.closeReason,
    uptimeBefore: e.uptimeBefore,
    uptimeAfter: e.uptimeAfter,
    bootReason: e.bootReason,
    sessionAfter: e.sessionAfter,
    agentVersionBefore: e.agentVersionBefore,
    agentVersionAfter: e.agentVersionAfter,
    bundleId: e.bundleId,
    bundleReady: e.bundleReady,
  }));

  const at = query.at ? new Date(query.at) : null;

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={`/devices/${device.id}`}
        className="flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {device.name}
      </Link>

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Connectivity</h1>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{device.serial}</p>
        </div>
        <nav className="flex gap-1 text-xs">
          {Object.entries(WINDOWS).map(([key, win]) => (
            <Link
              key={key}
              href={`/devices/${device.id}/connectivity?range=${key}`}
              className={
                key === range
                  ? "rounded-md bg-secondary px-2 py-1 font-medium"
                  : "rounded-md px-2 py-1 text-muted-foreground hover:text-foreground"
              }
            >
              {win.label}
            </Link>
          ))}
        </nav>
      </header>

      {device.kind === "BOX" ? (
        <DeviceShortcuts
          deviceId={device.id}
          current="connectivity"
          hasRotom={!!device.rotomDeviceId}
        />
      ) : null}

      {at && !Number.isNaN(at.getTime()) ? <IncidentWindow deviceId={device.id} at={at} /> : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Episodes" value={String(episodes.length)} />
        <Tile label="Total out of contact" value={forSeconds(totalDown)} />
        <Tile label="Longest" value={forSeconds(longest)} />
        <Tile
          label="Reboots / stalls"
          value={`${reboots} / ${stalls}`}
          hint="A reboot is the box restarting. A stall is the socket staying up while the beats stopped — reachable the whole time."
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Episodes</CardTitle>
        </CardHeader>
        <CardContent>
          <DeviceConnectivity deviceId={device.id} rows={rows} />
        </CardContent>
      </Card>
    </div>
  );
}

function forSeconds(seconds: number): string {
  if (seconds === 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}
