"use client";

import { useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { adoptHost, convergeHost, scaleHost } from "@/actions/hosts";
import { formatBytes } from "@/lib/format";

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
  workersPerInstance: number;
  /** The two inputs of the CPU half, so it can be redone as the field changes. */
  cpuCount: number | null;
  workersPerVCpu: number;
  /** Memory per container and what is held back for the machine, both in bytes. */
  memLimitBytes: number;
  hostReserveBytes: number;
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
  capacity,
  canOperate,
}: {
  hostId: string;
  adopted: boolean;
  converging: boolean;
  instances: number;
  workers: number | null;
  capacity: Capacity;
  canOperate: boolean;
}) {
  const [count, setCount] = useState(String(instances));
  const [workerCount, setWorkerCount] = useState(String(workers ?? capacity.workersPerInstance));
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const parsedCount = Number(count);
  const parsedWorkers = Number(workerCount);
  const valid =
    Number.isInteger(parsedCount) &&
    parsedCount >= 0 &&
    parsedCount <= 64 &&
    Number.isInteger(parsedWorkers) &&
    parsedWorkers >= 1 &&
    parsedWorkers <= 50;

  /**
   * The CPU half, for the workers actually typed.
   *
   * The server computes it from the workers-per-instance in Settings, which is
   * the only number it has — so typing 25 into the field left the suggestion
   * still assuming 50, and the same sentence said "0 by cores … at 25 workers
   * each". This is the CPU half of `planCapacity`, which is one division, and
   * it belongs here because the value it divides by lives in this form.
   */
  const byCpu = useMemo(() => {
    if (capacity.cpuCount === null) return capacity.byCpu;
    if (!Number.isInteger(parsedWorkers) || parsedWorkers < 1) return capacity.byCpu;
    return Math.max(0, Math.floor((capacity.cpuCount * capacity.workersPerVCpu) / parsedWorkers));
  }, [capacity, parsedWorkers]);

  const suggested = useMemo(() => {
    const both = [capacity.byMemory, byCpu].filter((n): n is number => n !== null);
    return both.length === 0 ? null : Math.min(...both);
  }, [capacity.byMemory, byCpu]);

  // Past the suggestion is a warning and not a refusal: these coefficients are
  // planning numbers, and an operator with their own measurements of their own
  // hardware is better informed than they are.
  const over = suggested !== null && Number.isInteger(parsedCount) && parsedCount > suggested;
  // Past what memory allows is different in kind. The OOM killer takes a
  // container down rather than slowing it, so this one says so plainly.
  const overMemory =
    capacity.byMemory !== null && Number.isInteger(parsedCount) && parsedCount > capacity.byMemory;

  function run(action: () => Promise<{ ok?: boolean; error?: string; reason?: string }>) {
    setMessage(null);
    setError(null);
    start(async () => {
      const result = await action();
      if (result.error) setError(result.error);
      else setMessage(result.reason ?? "Done.");
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
          <div className="space-y-1.5">
            <Label htmlFor="instances">Instances</Label>
            <Input
              id="instances"
              className="w-24 tabular-nums"
              value={count}
              inputMode="numeric"
              onChange={(event) => setCount(event.target.value)}
              disabled={!canOperate || pending}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="workers">Workers each</Label>
            <Input
              id="workers"
              className="w-24 tabular-nums"
              value={workerCount}
              inputMode="numeric"
              onChange={(event) => setWorkerCount(event.target.value)}
              disabled={!canOperate || pending}
            />
          </div>
          {canOperate ? (
            <Button
              onClick={() => run(() => scaleHost(hostId, parsedCount, parsedWorkers))}
              disabled={pending || !valid}
            >
              {pending ? "Applying…" : "Save"}
            </Button>
          ) : null}
          {canOperate ? (
            <Button
              variant="ghost"
              onClick={() => run(() => convergeHost(hostId))}
              disabled={pending}
            >
              Re-apply
            </Button>
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
              {suggested === 1 ? "container" : "containers"} — {capacity.byMemory} by memory,{" "}
              {byCpu} by cores. At {parsedWorkers || capacity.workersPerInstance} workers each that
              is {suggested * (parsedWorkers || capacity.workersPerInstance)} workers.
            </p>
          )}
          {suggested === 0 ? (
            <p>
              Zero because {capacity.byMemory === 0 ? "its memory" : "its cores"} says so:{" "}
              {formatBytes(capacity.memLimitBytes)} per container with{" "}
              {formatBytes(capacity.hostReserveBytes)} held back for the machine itself, and{" "}
              {capacity.workersPerVCpu} workers per core. Both live in{" "}
              <strong>Settings → Tuning</strong> and are fleet-wide — this machine is simply smaller
              than they assume.
            </p>
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
              Instances must be 0–64, and workers 1–50. Zero instances is how a machine is drained.
            </p>
          ) : null}
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
      </CardContent>
    </Card>
  );
}
