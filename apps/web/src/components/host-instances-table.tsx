"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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
import { removeInstance, setHostGroup } from "@/actions/hosts";

export type InstanceRow = {
  id: string;
  index: number;
  serial: string;
  workers: number | null;
  containerState: string | null;
  restartCount: number | null;
  reportedAt: string | null;
  device: { id: string; name: string } | null;
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
function stateOf(containerState: string | null, deviceId: string | null) {
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
  canOperate,
}: {
  hostId: string;
  instances: InstanceRow[];
  groups: { id: string; name: string }[];
  defaultGroupId: string | null;
  canOperate: boolean;
}) {
  const [pending, start] = useTransition();
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
                    <Badge variant={state.tone}>{state.label}</Badge>
                  </TableCell>
                  <TableCell align="right">{row.workers ?? "—"}</TableCell>
                  <TableCell align="right">
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

      {error ? <p className="px-6 pb-4 text-sm text-danger">{error}</p> : null}

      <ConfirmDialog
        open={doomed !== null}
        onOpenChange={(open) => !open && setDoomed(null)}
        title={
          doomed?.forget
            ? `Forget instance ${doomed.row.index}?`
            : `Remove instance ${doomed?.row.index}?`
        }
        description={
          doomed?.forget
            ? "The container, its /data volume and the box's row all go. Its history, its name and its identity go with them, and re-adding this index later creates a new box."
            : "The container goes. Its volume and the box's row stay, so re-adding this index brings the same box back with everything it had. Any job it is running is cancelled first."
        }
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
