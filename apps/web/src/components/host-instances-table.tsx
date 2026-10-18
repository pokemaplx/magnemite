"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { renderInstanceName } from "@magnemite/db/instance-name";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RelativeTime } from "@/components/relative-time";
import { InstanceSetup } from "@/components/instance-setup";
import { removeInstance, setHostGroup, setHostNameTemplate } from "@/actions/hosts";
import { formatBytes } from "@/lib/format";
import { FORGET_INSTANCE_DESCRIPTION, REMOVE_INSTANCE_DESCRIPTION } from "@/lib/instance-removal";
import type { SetupView } from "@/lib/instance-setup";

export type InstanceRow = {
  id: string;
  index: number;
  serial: string;
  workers: number | null;
  containerState: string | null;
  restartCount: number | null;
  reportedAt: string | null;
  device: {
    id: string;
    name: string;
    /** The container's own cgroup, as a share of one core. */
    cpuPercent: number | null;
    memTotalBytes: number | null;
    memAvailableBytes: number | null;
  } | null;
  /**
   * Where it has got to while it is being set up -- shown in place of the
   * state badge -- and null once it is up, or broken in a way the badge says.
   */
  setup: SetupView | null;
};

/**
 * What a machine is running, and the two ways to stop running it.
 *
 * Remove and forget are separate on purpose, and the table says which does
 * what rather than making an operator guess from a verb:
 *
 *   remove — destroys the container, keeps the volume and the box's row, so
 *            re-adding that index brings the same box back with its history,
 *            its name and its group
 *   forget — destroys both, and the box's identity goes with it
 *
 * Neither renumbers. Removing index 3 of ten leaves a gap the next scale-up
 * refills, because closing it would rewrite serials and a changed serial is a
 * new box with no history.
 */
/**
 * Used of total, which is the way round an operator reads a container: not
 * "is there room" — the machine's own card answers that — but "which of these
 * is heavy".
 */
export function memoryUsed(device: InstanceRow["device"]): string {
  if (!device || device.memTotalBytes === null || device.memAvailableBytes === null) return "—";
  return `${formatBytes(device.memTotalBytes - device.memAvailableBytes)} / ${formatBytes(device.memTotalBytes)}`;
}

export function stateOf(containerState: string | null, deviceId: string | null) {
  if (containerState === null) return { label: "unknown", tone: "secondary" as const };
  if (containerState !== "running") return { label: containerState, tone: "danger" as const };
  // The state worth having a word for: the container is up and its agent has
  // never enrolled. The commonest failure while setting a machine up, and
  // before instance rows existed nothing could tell it from "not running".
  if (deviceId === null) return { label: "not enrolled", tone: "warning" as const };
  return { label: "running", tone: "success" as const };
}

export function HostInstancesTable({
  hostId,
  instances,
  groups,
  defaultGroupId,
  nameTemplate,
  hostName,
  canOperate,
}: {
  hostId: string;
  instances: InstanceRow[];
  groups: { id: string; name: string }[];
  defaultGroupId: string | null;
  /** Null means a box names itself from what Android reports. */
  nameTemplate: string | null;
  /** The machine's own name, which is what `{host}` renders to. */
  hostName: string;
  canOperate: boolean;
}) {
  const [pending, start] = useTransition();
  // Saved on blur rather than on every keystroke: this is one short string and
  // a write per character would be a write per character.
  const [template, setTemplate] = useState(nameTemplate ?? "");

  // The index the next container would take, for the preview to be this
  // machine's next name rather than a generic example. The allocator fills the
  // lowest free index rather than appending, so this follows it.
  const taken = new Set(instances.map((row) => row.index));
  let nextIndex = 1;
  while (taken.has(nextIndex)) nextIndex += 1;
  const [error, setError] = useState<string | null>(null);
  const [doomed, setDoomed] = useState<{ row: InstanceRow; forget: boolean } | null>(null);

  function run(action: () => Promise<{ error?: string }>) {
    setError(null);
    start(async () => {
      const result = await action();
      if (result.error) setError(result.error);
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 px-6 text-sm">
        <span className="text-muted-foreground">New containers join</span>
        <Select
          aria-label="Group new containers join"
          placeholder="Select group…"
          value={defaultGroupId ?? ""}
          disabled={!canOperate || pending}
          className="w-44"
          options={[
            { value: "", label: "No group" },
            ...groups.map((group) => ({ value: group.id, label: group.name })),
          ]}
          onValueChange={(value) => run(() => setHostGroup(hostId, value || null))}
        />
        {/* Said here because the consequence is invisible otherwise: a box in
            the wrong group is handed the wrong MITM config by the first
            rollout that reaches it, with the sha256 read-back faithfully
            confirming the wrong file. */}
        <span className="text-xs text-muted-foreground">
          Decides which MITM config a new box is given.
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-6 text-sm">
        <span className="text-muted-foreground">and are called</span>
        <Input
          aria-label="Name template for new containers"
          className="w-56 font-mono text-xs"
          // The placeholder is the default rather than an example, so an empty
          // field says what it falls back to instead of looking unset.
          placeholder="{host}-{index}"
          value={template}
          disabled={!canOperate || pending}
          onChange={(event) => setTemplate(event.target.value)}
          onBlur={() => {
            const next = template.trim();
            if (next === (nameTemplate ?? "")) return;
            run(() => setHostNameTemplate(hostId, next || null));
          }}
        />
        <span className="text-xs text-muted-foreground">
          {template.trim() ? (
            <>
              Next one:{" "}
              <span className="font-medium text-foreground">
                {renderInstanceName(template.trim(), {
                  host: hostName,
                  index: nextIndex,
                  serial: `rd-xxxxxx-${String(nextIndex).padStart(2, "0")}`,
                })}
              </span>
              . <code>{"{host}"}</code>, <code>{"{index}"}</code> and <code>{"{serial}"}</code>.
            </>
          ) : (
            <>
              Empty uses what the box reports, which is the same manufacturer and model on every
              box. <code>{"{host}"}</code>, <code>{"{index}"}</code> and <code>{"{serial}"}</code>.
            </>
          )}
        </span>
      </div>

      {instances.length === 0 ? (
        <p className="px-6 pb-6 text-sm text-muted-foreground">
          Nothing configured to run here yet.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead align="right">#</TableHead>
              <TableHead>Box</TableHead>
              <TableHead>Container</TableHead>
              <TableHead align="right">CPU</TableHead>
              <TableHead align="right">Memory</TableHead>
              <TableHead align="right">Workers</TableHead>
              <TableHead align="right">Restarts</TableHead>
              <TableHead>Reported</TableHead>
              {canOperate ? <TableHead /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {instances.map((row) => {
              const state = stateOf(row.containerState, row.device?.id ?? null);
              return (
                <TableRow key={row.id}>
                  <TableCell align="right" className="tabular-nums text-muted-foreground">
                    {row.index}
                  </TableCell>
                  <TableCell>
                    {row.device ? (
                      <Link href={`/devices/${row.device.id}`} className="font-medium">
                        {row.device.name}
                      </Link>
                    ) : (
                      <span className="font-mono text-xs text-muted-foreground">{row.serial}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {row.setup ? (
                      <InstanceSetup view={row.setup} />
                    ) : (
                      <Badge variant={state.tone}>{state.label}</Badge>
                    )}
                  </TableCell>
                  {/* Measured by the box itself, from inside its own cgroup —
                      which is why these are per container rather than a slice
                      of the machine's total guessed from outside. A box that
                      has not reported leaves them blank rather than zero. */}
                  <TableCell align="right" className="tabular-nums">
                    {row.device == null || row.device.cpuPercent === null
                      ? "—"
                      : `${Math.round(row.device.cpuPercent)}%`}
                  </TableCell>
                  <TableCell align="right" className="tabular-nums">
                    {memoryUsed(row.device)}
                  </TableCell>
                  <TableCell align="right" className="tabular-nums">
                    {row.workers ?? "—"}
                  </TableCell>
                  <TableCell align="right" className="tabular-nums">
                    {/* A climbing count is what separates crash-looping from
                        merely idle. */}
                    {row.restartCount ?? "—"}
                  </TableCell>
                  <TableCell>
                    <RelativeTime value={row.reportedAt} />
                  </TableCell>
                  {canOperate ? (
                    <TableCell align="right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          onClick={() => setDoomed({ row, forget: false })}
                        >
                          Remove
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          onClick={() => setDoomed({ row, forget: true })}
                        >
                          Forget
                        </Button>
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {error ? <p className="px-6 pb-4 text-sm text-destructive">{error}</p> : null}

      <ConfirmDialog
        open={doomed !== null}
        onOpenChange={(open) => !open && setDoomed(null)}
        title={
          doomed?.forget
            ? `Forget instance ${doomed.row.index}?`
            : `Remove instance ${doomed?.row.index}?`
        }
        description={doomed?.forget ? FORGET_INSTANCE_DESCRIPTION : REMOVE_INSTANCE_DESCRIPTION}
        confirmLabel={doomed?.forget ? "Forget it" : "Remove it"}
        pendingLabel={doomed?.forget ? "Forgetting…" : "Removing…"}
        pending={pending}
        onConfirm={() => {
          const target = doomed;
          setDoomed(null);
          if (target) run(() => removeInstance(target.row.id, target.forget));
        }}
      />
    </div>
  );
}
