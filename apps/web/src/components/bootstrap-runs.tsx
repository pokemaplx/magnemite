import { Check, Circle, Loader2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { DismissBootstrap } from "@/components/dismiss-bootstrap";
import { RelativeTime } from "@/components/relative-time";
import { cn } from "@/lib/utils";

/**
 * The stages of `agent/host/bootstrap.sh`, in the order it runs them.
 *
 * Mirrors the names its `step` lines print -- the script is the source, and a
 * stage added there without being added here still counts as done when it
 * lands, it just has no place reserved in the list. `label` is the stage as
 * done, `doing` is what the machine is busy with while it is the next one.
 */
const STAGES = [
  { name: "arch", label: "arm64", doing: "Checking the CPU is arm64" },
  { name: "modules", label: "Kernel modules", doing: "Loading the binder kernel modules" },
  { name: "binder", label: "Binder", doing: "Checking binder works" },
  { name: "pidmax", label: "pid_max", doing: "Raising the process limit" },
  { name: "docker", label: "Docker", doing: "Installing Docker" },
  { name: "swap", label: "Swap", doing: "Setting up swap" },
  {
    name: "image",
    label: "Redroid image",
    // The one stage worth warning about: a gigabyte pulled, or a build when
    // the registry cannot be reached, and nothing printed until it is over.
    doing: "Getting the Redroid image — the longest stage, minutes on a slow link",
  },
  { name: "harden", label: "Hardening", doing: "Setting up the firewall and fail2ban" },
  { name: "adb", label: "adb", doing: "Installing adb" },
  { name: "config", label: "Agent config", doing: "Writing the agent's config" },
  { name: "agent", label: "Agent", doing: "Installing and starting the agent" },
  { name: "done", label: "Done", doing: "Finishing" },
] as const;

/** The script's stages, and then the machine dialling in, which closes it out. */
const TOTAL = STAGES.length + 1;

export type BootstrapRun = {
  id: string;
  name: string;
  address: string;
  state: "RUNNING" | "WAITING" | "FAILED";
  steps: { name: string; ok: boolean; detail: string }[];
  error: string | null;
  /** ISO. */
  startedAt: string;
};

/**
 * Machines being provisioned, each as how far it has got.
 *
 * A twenty-minute run used to read as one word that changed now and then. The
 * bar is stages done out of everything there is to do, the line under it says
 * what the machine is busy with, and the list shows what each finished stage
 * reported -- hover one for its detail. It moves on its own: every step that
 * lands is pushed to the page.
 */
export function BootstrapRuns({ runs, canOperate }: { runs: BootstrapRun[]; canOperate: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium">Being provisioned</p>
      {runs.map((run) => (
        <RunCard key={run.id} run={run} canOperate={canOperate} />
      ))}
    </div>
  );
}

function RunCard({ run, canOperate }: { run: BootstrapRun; canOperate: boolean }) {
  // Latest word per stage: a stage can print twice, a warning and then its
  // outcome, and it is the outcome that counts.
  const byName = new Map(run.steps.map((step) => [step.name, step]));
  const failedStep = run.steps.find((step) => !step.ok) ?? null;
  const done = STAGES.filter((stage) => byName.get(stage.name)?.ok).length;
  const next = STAGES.find((stage) => !byName.has(stage.name)) ?? null;
  // Stages the script printed that this list has no place for.
  const extra = run.steps.filter((step) => !STAGES.some((stage) => stage.name === step.name));

  const waiting = run.state === "WAITING";
  const failed = run.state === "FAILED";
  const reached = waiting ? STAGES.length : done;
  // A sliver while it connects, so the bar reads as started rather than empty.
  const percent = Math.max((reached / TOTAL) * 100, run.state === "RUNNING" ? 3 : 0);

  const now = failed
    ? failedStep
      ? `Stopped at ${labelOf(failedStep.name)}: ${failedStep.detail || "no detail"}`
      : "Stopped before the script reported a stage"
    : waiting
      ? // The script is through; only the machine can say it worked, by
        // enrolling -- after a reboot, if a kernel module needed one.
        "Set up. Waiting for it to dial in — a reboot first, if a kernel module needed one"
      : run.steps.length === 0
        ? "Connecting over SSH and uploading the setup"
        : (next?.doing ?? "Finishing");

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border bg-card p-4",
        failed ? "border-destructive/40" : "border-border",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{run.name}</span>
        <span className="font-mono text-xs text-muted-foreground">{run.address}</span>
        <Badge variant={failed ? "danger" : waiting ? "info" : "secondary"}>
          {failed ? "failed" : waiting ? "dialling in" : "provisioning"}
        </Badge>
        <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          <span>
            started <RelativeTime value={run.startedAt} live />
          </span>
          {/* Nothing prunes these rows, so a failure stays here until
              somebody says otherwise — which is right, and needs a way to say
              it. A run still genuinely going is refused by the action rather
              than hidden by the page. */}
          {canOperate ? <DismissBootstrap id={run.id} name={run.name} /> : null}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <Progress value={percent} tone={failed ? "danger" : "primary"} className="h-2" />
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {reached}/{TOTAL}
        </span>
      </div>

      <p
        className={cn(
          "flex items-center gap-2 text-sm",
          failed ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {!failed ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : null}
        {now}
      </p>

      <ol className="flex flex-wrap gap-1.5">
        {STAGES.map((stage) => {
          const step = byName.get(stage.name);
          const state = step
            ? step.ok
              ? "ok"
              : "failed"
            : !failed && !waiting && stage === next
              ? "current"
              : "pending";
          return (
            <StageChip
              key={stage.name}
              label={stage.label}
              state={state}
              title={step?.detail || (state === "current" ? stage.doing : undefined)}
            />
          );
        })}
        {extra.map((step) => (
          <StageChip
            key={step.name}
            label={step.name}
            state={step.ok ? "ok" : "failed"}
            title={step.detail || undefined}
          />
        ))}
        <StageChip
          label="Dialled in"
          state={waiting ? "current" : "pending"}
          title="The machine enrolling with the hub, which is what closes this out"
        />
      </ol>

      {failed && run.error ? (
        <pre className="max-h-32 overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
          {run.error}
        </pre>
      ) : null}
    </div>
  );
}

function labelOf(name: string): string {
  return STAGES.find((stage) => stage.name === name)?.label ?? name;
}

function StageChip({
  label,
  state,
  title,
}: {
  label: string;
  state: "ok" | "failed" | "current" | "pending";
  title?: string;
}) {
  return (
    <li
      title={title}
      className={cn(
        "flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs",
        state === "ok" && "border-border text-foreground",
        state === "failed" && "border-destructive/40 bg-destructive/10 text-destructive",
        state === "current" && "border-primary/40 bg-primary/5 text-foreground",
        state === "pending" && "border-dashed border-border text-muted-foreground",
      )}
    >
      {state === "ok" ? <Check className="h-3 w-3 text-success" /> : null}
      {state === "failed" ? <X className="h-3 w-3" /> : null}
      {state === "current" ? <Loader2 className="h-3 w-3 animate-spin text-primary" /> : null}
      {state === "pending" ? <Circle className="h-3 w-3 opacity-40" /> : null}
      {label}
    </li>
  );
}
