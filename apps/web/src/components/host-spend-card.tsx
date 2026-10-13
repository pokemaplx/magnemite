import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatBytes } from "@/lib/format";

export type SpendRow = {
  index: number;
  /** The box's name once it has enrolled, its serial until then. */
  label: string;
  enrolled: boolean;
  /** The container's own cgroup, as a share of one core. */
  cpuPercent: number | null;
  memUsedBytes: number | null;
};

/**
 * Where the machine's CPU and memory actually go.
 *
 * The Load card above is the total; this is the same total taken apart. It
 * needs no measurement of its own, which is the point: the machine reports its
 * own `/proc`, every enrolled container reports its own cgroup, and the
 * difference between the two is everything that is not a box — docker, the
 * agent, the kernel.
 *
 * That last row is the one worth having. A machine busier than its containers
 * explain is a different problem from a machine with one hot box, and before
 * this the page could not tell them apart: it had the total and, in the table
 * below, the parts, with nobody doing the subtraction.
 *
 * Three honesties it keeps rather than smoothing over:
 *
 *  - **A container that has not enrolled reports nothing**, and is listed
 *    saying so rather than being left out. Its spend is real and lands in the
 *    rest, so a rest that looks large may be a box that never came up.
 *  - **The readings are not simultaneous.** Each box and the machine report on
 *    their own heartbeat, so a few seconds separate them and the parts need
 *    not add up to the whole exactly.
 *  - **The rest can come out negative**, when the parts were measured at a
 *    busier moment than the whole. Clamped at zero and left unremarkable: the
 *    honest reading of it is "about nothing", not a negative quantity.
 */
export function HostSpendCard({
  cpuCount,
  hostCpuPercent,
  memTotalBytes,
  memUsedBytes,
  rows,
}: {
  cpuCount: number | null;
  hostCpuPercent: number | null;
  memTotalBytes: number | null;
  memUsedBytes: number | null;
  rows: SpendRow[];
}) {
  // A share of one core, so the machine's ceiling is its core count times 100
  // — the same convention every CPU figure in this project uses.
  const cpuCeiling = cpuCount === null ? null : cpuCount * 100;
  const known = rows.filter((row) => row.cpuPercent !== null || row.memUsedBytes !== null);

  const containersCpu = known.reduce((sum, row) => sum + (row.cpuPercent ?? 0), 0);
  const containersMem = known.reduce((sum, row) => sum + (row.memUsedBytes ?? 0), 0);
  const restCpu = hostCpuPercent === null ? null : Math.max(0, hostCpuPercent - containersCpu);
  const restMem = memUsedBytes === null ? null : Math.max(0, memUsedBytes - containersMem);

  const ordered = [...rows].sort((a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1));
  const silent = rows.filter((row) => row.cpuPercent === null && row.memUsedBytes === null).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Where it goes</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid grid-cols-2 gap-4">
          <Total
            label="CPU"
            reading={hostCpuPercent === null ? "—" : `${Math.round(hostCpuPercent)}%`}
            detail={
              cpuCeiling === null ? "cores not reported" : `of ${cpuCeiling}% across its cores`
            }
            percent={
              hostCpuPercent === null || cpuCeiling === null
                ? null
                : (hostCpuPercent / cpuCeiling) * 100
            }
          />
          <Total
            label="Memory"
            reading={memUsedBytes === null ? "—" : formatBytes(memUsedBytes)}
            detail={memTotalBytes === null ? "not reported" : `of ${formatBytes(memTotalBytes)}`}
            percent={
              memUsedBytes === null || !memTotalBytes ? null : (memUsedBytes / memTotalBytes) * 100
            }
          />
        </div>

        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nothing is configured to run here, so all of it is the machine itself.
          </p>
        ) : (
          <div className="space-y-2">
            {ordered.map((row) => (
              <Line
                key={row.index}
                label={row.label}
                muted={!row.enrolled}
                cpu={row.cpuPercent}
                mem={row.memUsedBytes}
                cpuCeiling={cpuCeiling}
                note={row.enrolled ? null : "not enrolled, so it reports nothing"}
              />
            ))}
            <Line
              label="Everything else"
              muted
              cpu={restCpu}
              mem={restMem}
              cpuCeiling={cpuCeiling}
              note="docker, the agent, the system"
            />
          </div>
        )}

        {silent > 0 ? (
          <p className="text-xs text-muted-foreground">
            {silent} container{silent === 1 ? "" : "s"} here {silent === 1 ? "reports" : "report"}{" "}
            nothing yet, so what {silent === 1 ? "it is" : "they are"} spending is counted in the
            rest.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Total({
  label,
  reading,
  detail,
  percent,
}: {
  label: string;
  reading: string;
  detail: string;
  percent: number | null;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{reading}</span>
      </div>
      <Progress
        value={percent ?? 0}
        tone={percent !== null && percent >= 90 ? "danger" : "primary"}
      />
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function Line({
  label,
  muted,
  cpu,
  mem,
  cpuCeiling,
  note,
}: {
  label: string;
  muted?: boolean;
  cpu: number | null;
  mem: number | null;
  cpuCeiling: number | null;
  note: string | null;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-32 shrink-0 truncate" title={label}>
        <span className={muted ? "text-muted-foreground" : "font-medium"}>{label}</span>
      </div>
      <div className="min-w-0 flex-1">
        <Progress
          value={cpu === null || cpuCeiling === null ? 0 : (cpu / cpuCeiling) * 100}
          tone={muted ? "muted" : "primary"}
        />
        {note ? <p className="mt-0.5 text-xs text-muted-foreground">{note}</p> : null}
      </div>
      <div className="w-16 shrink-0 text-right tabular-nums">
        {cpu === null ? "—" : `${Math.round(cpu)}%`}
      </div>
      <div className="w-24 shrink-0 text-right tabular-nums text-muted-foreground">
        {mem === null ? "—" : formatBytes(mem)}
      </div>
    </div>
  );
}
