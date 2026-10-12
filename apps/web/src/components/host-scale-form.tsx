"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { adoptHost, convergeHost, scaleHost } from "@/actions/hosts";

export type Capacity = {
  /** How many containers the machine's memory allows. A real ceiling. */
  byMemory: number | null;
  /** What the CPU coefficient suggests. Advice, not a limit. */
  byCpu: number | null;
  suggested: number | null;
  workersPerInstance: number;
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

  // Past the suggestion is a warning and not a refusal: these coefficients are
  // planning numbers, and an operator with their own measurements of their own
  // hardware is better informed than they are.
  const over =
    capacity.suggested !== null &&
    Number.isInteger(parsedCount) &&
    parsedCount > capacity.suggested;
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
          {error ? <p className="text-danger">{error}</p> : null}
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
          {capacity.suggested === null ? (
            <p>
              This machine has not reported its cores or memory yet, so there is nothing to size
              against.
            </p>
          ) : (
            <p>
              Room for about <span className="font-medium">{capacity.suggested}</span>{" "}
              {capacity.suggested === 1 ? "container" : "containers"} — {capacity.byMemory} by
              memory, {capacity.byCpu} by cores. At {parsedWorkers || capacity.workersPerInstance}{" "}
              workers each that is{" "}
              {(capacity.suggested || 0) * (parsedWorkers || capacity.workersPerInstance)} workers.
            </p>
          )}
          {overMemory ? (
            <p className="text-danger">
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
            <p className="text-danger">
              Instances must be 0–64, and workers 1–50. Zero instances is how a machine is drained.
            </p>
          ) : null}
        </div>

        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
      </CardContent>
    </Card>
  );
}
