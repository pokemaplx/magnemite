import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { prisma } from "@magnemite/db";
import { requireUser } from "@/lib/session";
import { loadDeviceMetrics } from "@/lib/metrics";
import { parseRange } from "@/lib/metrics-view";
import { DeviceMetrics } from "@/components/device-metrics";
import { DeviceShortcuts } from "@/components/device-shortcuts";
import { OnlineDot } from "@/components/status";

export const dynamic = "force-dynamic";

/**
 * A box's health over time, which the device page's Load card can only show as
 * "right now".
 *
 * Its own route rather than an expanded card: the window, and which apps are
 * charted, belong in the URL — a box that was hot at 3am is something you send
 * someone a link to.
 */
export default async function DeviceMetricsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ range?: string; packages?: string }>;
}) {
  await requireUser();
  const { id } = await params;
  const query = await searchParams;

  const device = await prisma.device.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      serial: true,
      status: true,
      cpuCount: true,
      kind: true,
      rotomDeviceId: true,
    },
  });
  if (!device) notFound();

  const view = await loadDeviceMetrics(id, {
    range: parseRange(query.range),
    packages: query.packages ? query.packages.split(",").filter(Boolean) : null,
  });

  return (
    <div className="flex flex-col gap-5">
      <Link
        href={`/devices/${device.id}`}
        className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {device.name}
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <OnlineDot online={device.status === "ONLINE"} />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Load history</h1>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {device.serial}
              {device.cpuCount ? ` · ${device.cpuCount} cores` : ""}
            </p>
          </div>
        </div>
      </header>

      {/* A machine's load lives here too, reached from its own page; the keys
          are for a box's pages, which a machine does not have. */}
      {device.kind === "BOX" ? (
        <DeviceShortcuts deviceId={device.id} current="metrics" hasRotom={!!device.rotomDeviceId} />
      ) : null}

      <DeviceMetrics view={view} />
    </div>
  );
}
