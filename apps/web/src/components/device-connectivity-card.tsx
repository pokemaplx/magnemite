import Link from "next/link";
import { History, PlugZap } from "lucide-react";
import { StateStrip } from "@/components/charts/state-strip";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
/**
 * Seconds as something readable. `formatDuration` in lib/format takes two
 * instants, and an episode already carries the difference.
 */
function forSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
import { CAUSE_LABELS, type ConnectivityTrend, type Episode } from "@/lib/connectivity";

/**
 * Staying in touch with this box, over the last hour and the last day.
 *
 * Two bands rather than one, because one cannot say it. The socket being up
 * and the beats arriving are different facts, and the gap between them is the
 * fault that used to be reported as "unreachable" — a box sitting there
 * perfectly reachable with a wedged agent.
 */
export function DeviceConnectivityCard({
  deviceId,
  trend,
  episodes,
  bootedAt,
  agentStartedAt,
  beatStaleSince,
}: {
  deviceId: string;
  trend: ConnectivityTrend;
  /** The last 24h, newest first. */
  episodes: Episode[];
  bootedAt: Date | null;
  agentStartedAt: Date | null;
  beatStaleSince: Date | null;
}) {
  const closed = episodes.filter((e) => e.durationSeconds !== null);
  const longest = closed.reduce((max, e) => Math.max(max, e.durationSeconds ?? 0), 0);
  const reboots = episodes.filter((e) => e.cause === "REBOOT").length;
  const last = episodes[0];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2">
          <PlugZap className="h-4 w-4 text-muted-foreground" />
          Connectivity
        </CardTitle>
        <Button asChild variant="ghost" size="icon" aria-label="Connectivity history">
          <Link href={`/devices/${deviceId}/connectivity`}>
            <History className="h-4 w-4" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <Band label="Reachable" values={trend.reachable} />
        <Band label="Reporting" values={trend.reporting} />

        {beatStaleSince ? (
          <p className="text-xs text-warning-foreground">
            Connected, and nothing since <RelativeTime value={beatStaleSince.toISOString()} />. A
            restart or a reboot can still be sent to it.
          </p>
        ) : null}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t pt-3 text-xs">
          <Field label="Booted">
            {bootedAt ? <RelativeTime value={bootedAt.toISOString()} /> : "—"}
          </Field>
          <Field label="Agent started">
            {agentStartedAt ? <RelativeTime value={agentStartedAt.toISOString()} /> : "—"}
          </Field>
          <Field label="Episodes (24h)">{episodes.length}</Field>
          <Field label="Longest">{longest > 0 ? forSeconds(longest) : "—"}</Field>
        </dl>

        {last ? (
          <p className="text-xs text-muted-foreground">
            Last: <RelativeTime value={last.startedAt.toISOString()} />
            {last.cause ? ` — ${CAUSE_LABELS[last.cause]}` : " — still out of contact"}
            {reboots > 0 ? ` · ${reboots} reboot${reboots === 1 ? "" : "s"} today` : null}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">No loss of contact in the last day.</p>
        )}
      </CardContent>
    </Card>
  );
}

function Band({ label, values }: { label: string; values: (boolean | null)[] }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      {values.length > 0 ? (
        <StateStrip values={values} width={140} height={10} />
      ) : (
        <span className="text-xs text-muted-foreground">not recorded</span>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}
