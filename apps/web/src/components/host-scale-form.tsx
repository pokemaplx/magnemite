"use client";

import { type ReactNode, useEffect, useMemo, useState, useTransition } from "react";
import { MoreHorizontal, RefreshCw, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { adoptHost, convergeHost, rerunBootstrap, scaleHost } from "@/actions/hosts";
import { formatBytes } from "@/lib/format";

/**
 * Why the suggestion is zero, and which number to move.
 *
 * A machine that fits nothing is the one case where the figure alone is no
 * use: it is arithmetic done with two fleet-wide knobs, and without seeing the
 * subtraction an operator cannot tell whether the machine is too small or the
 * defaults are too big for it. So this shows the sum, names only the half that
 * actually produced the zero, and says what would have to change.
 *
 * Memory first when both are zero, because memory is the real ceiling — past
 * it the OOM killer takes boxes down, while the cores figure is a planning
 * coefficient somebody may legitimately overrule.
 */
function WhyZero({
  capacity,
  byMemory,
  byCpu,
  memLimitBytes,
  workers,
}: {
  capacity: Capacity;
  byMemory: number | null;
  byCpu: number | null;
  /** The ceiling the arithmetic used — the one typed into the field. */
  memLimitBytes: number;
  workers: number;
}) {
  const perWorker =
    Number.isInteger(workers) && workers >= 1 ? workers : capacity.workersPerInstance;

  if (byMemory === 0 && capacity.memTotalBytes !== null) {
    const headroom = capacity.memTotalBytes - capacity.hostReserveBytes;
    return (
      <p>
        Zero on memory: {formatBytes(capacity.memTotalBytes)} total, less{" "}
        {formatBytes(capacity.hostReserveBytes)} held back for the machine, leaves{" "}
        <span className="font-medium">{formatBytes(headroom)}</span> — and each container is given{" "}
        {formatBytes(memLimitBytes)}. One would fit at{" "}
        <span className="font-medium">{formatBytes(headroom)}</span> each or less. Memory each is
        the field above, on this machine; the rest is fleet-wide, in{" "}
        <strong>Settings → Tuning</strong>.
      </p>
    );
  }

  if (byCpu === 0 && capacity.cpuCount !== null) {
    const fits = capacity.cpuCount * capacity.workersPerVCpu;
    return (
      <p>
        Zero on cores: {capacity.cpuCount} core{capacity.cpuCount === 1 ? "" : "s"} ×{" "}
        {capacity.workersPerVCpu} workers each is <span className="font-medium">{fits}</span>, and
        one container here is asking for {perWorker}. It would fit at{" "}
        <span className="font-medium">{fits}</span> workers or fewer. Workers each is the field
        above, on this machine; workers per vCPU is fleet-wide, in{" "}
        <strong>Settings → Tuning</strong>.
      </p>
    );
  }

  return null;
}

/**
 * A label over an input, in a row that lines its fields up on their bottom
 * edge.
 *
 * The input gets a box of its own height because password managers put their
 * in-field icon *next to* it, as a sibling in the DOM. Left in the column, that
 * sibling took the column's spacing, made the one field holding it taller than
 * the rest, and `items-end` lifted that field out of line with its neighbours
 * and the Save button. Inside a fixed-height box, whatever lands there cannot
 * change the column.
 */
function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="h-9">{children}</div>
    </div>
  );
}

export type Capacity = {
  /** How many containers the machine's memory allows. A real ceiling. */
  byMemory: number | null;
  /**
   * What the CPU coefficient suggests, for the workers-per-instance the
   * *settings* say. Advice, not a limit — and recomputed below for the number
   * actually typed in this form, which is the one the operator is asking
   * about.
   */
  byCpu: number | null;
  suggested: number | null;
  /**
   * The fleet-wide number from Settings, named as what an empty Workers each
   * falls back to -- the same job `fleetMemLimitBytes` does for memory.
   */
  workersPerInstance: number;
  /** The two inputs of the CPU half, so it can be redone as the field changes. */
  cpuCount: number | null;
  workersPerVCpu: number;
  /**
   * Memory per container and what is held back for the machine, both in bytes.
   *
   * `memLimitBytes` is the **effective** one: this machine's override when it
   * has one, the fleet-wide setting when it does not. The sentence that
   * explains a suggestion of zero does its arithmetic with it, so a machine
   * tuned down to 2 GB must not be told it is being given 4.
   */
  memLimitBytes: number;
  hostReserveBytes: number;
  /** The fleet-wide number, named as the thing an empty field falls back to. */
  fleetMemLimitBytes: number;
  /** The machine's own, so the sentence can show the subtraction. */
  memTotalBytes: number | null;
};

/**
 * How many containers this machine runs, and what that costs it.
 *
 * The number is the whole feature: before this, adding a box meant copying a
 * YAML block by hand. Everything else on the card exists so the number is an
 * informed choice rather than a guess — which is why the capacity line is
 * advice with its reasoning shown, and not a cap that refuses.
 */
export function HostScaleForm({
  hostId,
  adopted,
  converging,
  instances,
  workers,
  customWorkers,
  memLimitBytes,
  capacity,
  canOperate,
}: {
  hostId: string;
  adopted: boolean;
  converging: boolean;
  instances: number;
  /** This machine's own worker count, or null when it follows Settings. */
  workers: number | null;
  /** How many of its containers have a number of their own, which this leaves alone. */
  customWorkers: number;
  /** This machine's own ceiling, or null when it inherits the fleet's. */
  memLimitBytes: number | null;
  capacity: Capacity;
  canOperate: boolean;
}) {
  const [count, setCount] = useState(String(instances));
  /**
   * Empty for the same reason Memory each is: empty is a value, it means
   * follow Settings. Pre-filling the fleet's number is what used to turn it
   * into a copy -- the first Save wrote it onto the machine, and changing the
   * setting afterwards moved nothing.
   */
  const [workerCount, setWorkerCount] = useState(workers === null ? "" : String(workers));

  // Followed rather than kept: an instance added or removed in the table below
  // changes the count, and a Save still holding the old number would quietly
  // undo it.
  useEffect(() => setCount(String(instances)), [instances]);
  useEffect(() => setWorkerCount(workers === null ? "" : String(workers)), [workers]);
  /**
   * In GB, because that is the unit the rest of this card is written in, and
   * empty because empty is a value here rather than a missing one: it means
   * inherit, and it is how an override is removed.
   *
   * One decimal, so 2.5 is sayable. Below a gigabyte nobody is tuning a
   * Redroid container.
   */
  const [memLimit, setMemLimit] = useState(
    memLimitBytes === null ? "" : String(Math.round((memLimitBytes / 1024 ** 3) * 10) / 10),
  );
  const [confirmRerun, setConfirmRerun] = useState(false);
  /**
   * Whether the last thing that happened was a setup run, so the half nobody
   * can see from here can be named.
   *
   * Building the image does not move the containers onto it — the compose file
   * did not change, so nothing recreates them — and Re-apply is the second
   * step. That was already easy to miss when both buttons sat side by side;
   * with Re-apply behind a menu it would be invisible, so the first step says
   * what the second one is.
   */
  const [setupStarted, setSetupStarted] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const parsedCount = Number(count);

  // Empty follows Settings, so it parses to the fleet's number for the
  // arithmetic and to null for the Save.
  const workersTyped = workerCount.trim();
  const parsedWorkers = workersTyped === "" ? null : Number(workersTyped);
  const workersValid =
    parsedWorkers === null ||
    (Number.isInteger(parsedWorkers) && parsedWorkers >= 1 && parsedWorkers <= 50);
  const effectiveWorkers =
    parsedWorkers !== null && workersValid ? parsedWorkers : capacity.workersPerInstance;

  // Empty is a value: it means inherit. So it parses to the fleet-wide number
  // rather than to nothing, because the arithmetic below has to be able to
  // show what clearing the field would do.
  const memTyped = memLimit.trim();
  const parsedMemGb = memTyped === "" ? null : Number(memTyped);
  const memValid =
    parsedMemGb === null ||
    (Number.isFinite(parsedMemGb) && parsedMemGb >= 0.5 && parsedMemGb <= 64);
  const effectiveMemBytes =
    parsedMemGb !== null && memValid
      ? Math.round(parsedMemGb * 1024 ** 3)
      : capacity.fleetMemLimitBytes;

  const valid =
    Number.isInteger(parsedCount) &&
    parsedCount >= 0 &&
    parsedCount <= 64 &&
    workersValid &&
    memValid;

  /**
   * The CPU half, for the workers actually typed — or, with the field empty,
   * for the fleet's number it then follows.
   *
   * The server computes it from the number this machine has stored, and the
   * point of the field is to see what a different one would fit before saving
   * it. This is the CPU half of `planCapacity`, which is one division, and it
   * belongs here because the value it divides by lives in this form.
   */
  const byCpu = useMemo(() => {
    if (capacity.cpuCount === null) return capacity.byCpu;
    return Math.max(
      0,
      Math.floor((capacity.cpuCount * capacity.workersPerVCpu) / effectiveWorkers),
    );
  }, [capacity, effectiveWorkers]);

  /**
   * The memory half, for the ceiling actually typed.
   *
   * Redone here for the same reason the CPU half is: the server computed it
   * with the limit this machine has stored, and the entire point of the field
   * is to see what a different one would fit *before* saving it and recreating
   * every container to find out.
   */
  const byMemory = useMemo(() => {
    if (capacity.memTotalBytes === null) return capacity.byMemory;
    if (effectiveMemBytes <= 0) return capacity.byMemory;
    return Math.max(
      0,
      Math.floor((capacity.memTotalBytes - capacity.hostReserveBytes) / effectiveMemBytes),
    );
  }, [capacity, effectiveMemBytes]);

  const suggested = useMemo(() => {
    const both = [byMemory, byCpu].filter((n): n is number => n !== null);
    return both.length === 0 ? null : Math.min(...both);
  }, [byMemory, byCpu]);

  // Past the suggestion is a warning and not a refusal: these coefficients are
  // planning numbers, and an operator with their own measurements of their own
  // hardware is better informed than they are.
  const over = suggested !== null && Number.isInteger(parsedCount) && parsedCount > suggested;
  // Past what memory allows is different in kind. The OOM killer takes a
  // container down rather than slowing it, so this one says so plainly.
  const overMemory = byMemory !== null && Number.isInteger(parsedCount) && parsedCount > byMemory;

  function run(
    action: () => Promise<{ ok?: boolean; error?: string; reason?: string }>,
    onOk?: () => void,
  ) {
    setMessage(null);
    setError(null);
    setSetupStarted(false);
    start(async () => {
      const result = await action();
      if (result.error) setError(result.error);
      else {
        setMessage(result.reason ?? "Done.");
        onOk?.();
      }
    });
  }

  if (!adopted) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Not adopted yet</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            Nothing is applied to this machine until its existing containers have been imported. If
            it is already running some — from a hand-written compose file, say — they hold real
            device identities, and applying an empty set would treat every one of them as an orphan
            and remove it.
          </p>
          <p>A machine with nothing on it adopts an empty set, and this step is a formality.</p>
          {canOperate ? (
            <Button onClick={() => run(() => adoptHost(hostId))} disabled={pending}>
              {pending ? "Adopting…" : "Adopt this machine"}
            </Button>
          ) : null}
          {error ? <p className="text-destructive">{error}</p> : null}
          {message ? <p>{message}</p> : null}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-sm">Containers</CardTitle>
        {converging ? <span className="text-xs text-muted-foreground">converging…</span> : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field id="instances" label="Instances">
            <Input
              id="instances"
              className="w-24 tabular-nums"
              value={count}
              inputMode="numeric"
              onChange={(event) => setCount(event.target.value)}
              disabled={!canOperate || pending}
            />
          </Field>
          <Field id="workers" label="Workers each">
            <Input
              id="workers"
              className="w-24 tabular-nums"
              value={workerCount}
              inputMode="numeric"
              // The fleet's number, so an empty field says what it follows
              // rather than looking unset.
              placeholder={String(capacity.workersPerInstance)}
              onChange={(event) => setWorkerCount(event.target.value)}
              disabled={!canOperate || pending}
            />
          </Field>
          <Field id="memLimit" label="Memory each">
            <Input
              id="memLimit"
              className="w-28 tabular-nums"
              value={memLimit}
              inputMode="decimal"
              // The fleet-wide number, so an empty field says what it inherits
              // rather than looking unset.
              placeholder={`${Math.round((capacity.fleetMemLimitBytes / 1024 ** 3) * 10) / 10} GB`}
              onChange={(event) => setMemLimit(event.target.value)}
              disabled={!canOperate || pending}
            />
          </Field>
          {canOperate ? (
            <Button
              onClick={() =>
                run(() =>
                  scaleHost(
                    hostId,
                    parsedCount,
                    // Null clears either override. Both are sent on every Save
                    // rather than only when they changed, so emptying a field
                    // is a thing that can be saved at all.
                    parsedWorkers,
                    parsedMemGb === null ? null : Math.round(parsedMemGb * 1024 ** 3),
                  ),
                )
              }
              disabled={pending || !valid}
            >
              {pending ? "Applying…" : "Save"}
            </Button>
          ) : null}
          {/* Behind a menu, and not beside Save, because the three read as one
              set of three and are not: Save is the only one that reads the two
              fields. The other two act on the machine and ignore them, and one
              of those is half an hour of apt running as root. Side by side,
              the only thing separating a routine save from that was the word
              on the button. */}
          {canOperate ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" disabled={pending} aria-label="Machine actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-w-sm">
                <DropdownMenuLabel>This machine, not these numbers</DropdownMenuLabel>
                <DropdownMenuItem
                  className="items-start"
                  onSelect={() => run(() => convergeHost(hostId))}
                >
                  <RefreshCw className="mt-0.5 shrink-0" />
                  <span>
                    <span className="block">Re-apply</span>
                    <span className="mt-0.5 block whitespace-normal text-xs text-muted-foreground">
                      Sends the container set again, even when nothing changed. After the image tag
                      moves, or when the machine has drifted from it.
                    </span>
                  </span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="items-start" onSelect={() => setConfirmRerun(true)}>
                  <Wrench className="mt-0.5 shrink-0" />
                  <span>
                    <span className="block">Re-run setup</span>
                    <span className="mt-0.5 block whitespace-normal text-xs text-muted-foreground">
                      Rebuilds the Redroid image and reinstalls the kernel module. Up to half an
                      hour, as root. Leaves the containers and the agent alone.
                    </span>
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>

        <div className="space-y-1 text-xs text-muted-foreground">
          {suggested === null ? (
            <p>
              This machine has not reported its cores or memory yet, so there is nothing to size
              against.
            </p>
          ) : (
            <p>
              Room for about <span className="font-medium">{suggested}</span>{" "}
              {suggested === 1 ? "container" : "containers"} — {byMemory} by memory, {byCpu} by
              cores. At {effectiveWorkers} workers each that is {suggested * effectiveWorkers}{" "}
              workers.
            </p>
          )}
          {/* Where the number comes from, said every time: the field looks the
              same holding an override as following Settings, and the
              containers with their own number are the ones a Save here does
              not move. */}
          <p>
            {parsedWorkers === null ? (
              <>
                Workers each follows <strong>Settings → Tuning</strong>, now{" "}
                {capacity.workersPerInstance}, and moves when it does.
              </>
            ) : (
              <>
                Workers each is this machine&apos;s own; empty it to follow{" "}
                <strong>Settings → Tuning</strong> ({capacity.workersPerInstance}).
              </>
            )}{" "}
            {customWorkers > 0
              ? `${customWorkers} ${customWorkers === 1 ? "container has its" : "containers have their"} own number in Instances below, and ${customWorkers === 1 ? "keeps it" : "keep them"}.`
              : "A container can have its own number in Instances below."}{" "}
            Every box whose number changes has its MITM config rewritten to match, a few at a time —
            which restarts its scanner.
          </p>
          {suggested === 0 ? (
            <WhyZero
              capacity={capacity}
              byMemory={byMemory}
              byCpu={byCpu}
              memLimitBytes={effectiveMemBytes}
              workers={effectiveWorkers}
            />
          ) : null}
          {overMemory ? (
            <p className="text-destructive">
              Past what this machine&apos;s memory allows. The OOM killer takes a container down
              rather than slowing it, so boxes will disappear under load.
            </p>
          ) : over ? (
            <p className="text-warning">
              Past the suggestion. The cores figure is a planning coefficient rather than a limit —
              if you have measured this hardware yourself, your number is the better one.
            </p>
          ) : null}
          {!valid ? (
            <p className="text-destructive">
              Instances must be 0–64, workers each 1–50, and memory each between 0.5 and 64 GB — the
              last two may be empty to inherit the fleet&apos;s. Zero instances is how a machine is
              drained.
            </p>
          ) : null}
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
        {setupStarted ? (
          <p className="text-sm text-muted-foreground">
            Two steps, not one: building the image does not move the containers onto it, because the
            compose file did not change. When the run finishes, <strong>Re-apply</strong> — in the
            menu beside Save — is what recreates them.
          </p>
        ) : null}

        {/* Asked, because this is half an hour of apt and docker running as
            root on a machine that is working, started by a button that looks
            exactly like the two beside it. */}
        <ConfirmDialog
          open={confirmRerun}
          onOpenChange={setConfirmRerun}
          title="Run the setup script again?"
          description="It reinstalls the kernel module for the kernel running now — which an apt upgrade silently invalidates — and rebuilds the Redroid image when the tag is one this machine does not have. It takes up to half an hour, runs as root, and leaves the containers and the agent alone. Everything already satisfied is skipped."
          confirmLabel="Run it"
          pendingLabel="Asking…"
          pending={pending}
          onConfirm={() => {
            setConfirmRerun(false);
            run(
              () => rerunBootstrap(hostId),
              () => setSetupStarted(true),
            );
          }}
        />
      </CardContent>
    </Card>
  );
}
