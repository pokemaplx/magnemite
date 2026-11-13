import { StateStrip } from "@/components/charts/state-strip";
import { RelativeTime } from "@/components/relative-time";
import type { ConnectivityTrend } from "@/lib/connectivity";

/**
 * The last hour of staying in touch with a box, as two bands.
 *
 * Lives inside the State card rather than in one of its own: it is the same
 * question that card already asks — is this box alright — and the field right
 * above it, "Last heartbeat", is the number these two bands are the history
 * of. A fifth card for it only pushed Load onto a row by itself.
 *
 * Two bands because one cannot say it. The socket being up and the beats
 * arriving are different facts, and the gap between them is the fault that
 * used to be announced as "unreachable": a box sitting there perfectly
 * reachable with a wedged agent.
 */
export function ConnectivityBands({
  trend,
  beatStaleSince,
}: {
  trend: ConnectivityTrend;
  beatStaleSince: Date | null;
}) {
  return (
    <div className="mt-2 flex flex-col gap-1.5 border-t pt-2">
      <Band label="Reachable" values={trend.reachable} />
      <Band label="Reporting" values={trend.reporting} />
      {beatStaleSince ? (
        <p className="text-xs text-muted-foreground">
          Connected, nothing since <RelativeTime value={beatStaleSince.toISOString()} /> — a restart
          can still be sent.
        </p>
      ) : null}
    </div>
  );
}

function Band({ label, values }: { label: string; values: (boolean | null)[] }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      {values.length > 0 ? (
        <StateStrip values={values} width={120} height={9} />
      ) : (
        <span className="text-xs text-muted-foreground">not recorded</span>
      )}
    </div>
  );
}
