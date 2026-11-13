"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
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
import {
  addInstances,
  removeInstance,
  setHostGroup,
  setHostNameTemplate,
  setInstanceWorkers,
} from "@/actions/hosts";
import { formatBytes } from "@/lib/format";
import { FORGET_INSTANCE_DESCRIPTION, REMOVE_INSTANCE_DESCRIPTION } from "@/lib/instance-removal";
import type { SetupView } from "@/lib/instance-setup";

export type InstanceRow = {
  id: string;
  index: number;
  serial: string;
  /**
   * What this box is configured for, resolved: its own number, else its
   * machine's, else Settings. What `{{device.workers}}` renders.
   */
  workers: number;
  /** Its own number, or null when it inherits — which is what an edit changes. */
  ownWorkers: number | null;
  /**
   * The number its MITM config still says, while that is behind `workers`;
   * null when it is in step or nothing has been written yet.
   */
  configBehind: number | null;
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

/**
 * The number a box's MITM config still says, while it is behind the one the
 * box is configured for.
 *
 * The hub rewrites it by itself, so most of the time this is "on it" for a few
 * seconds. One that stays is the reason to look: the box is offline, busy
 * installing, parked, or its rewrite failed and is waiting to be tried again.
 */
export function ConfigBehind({ was }: { was: number }) {
  return (
    <span
      className="inline-flex items-center gap-0.5 text-xs text-warning"
      title={`Its MITM config still says ${was}. The hub rewrites it by itself once the box is online and not installing anything.`}
    >
      <RefreshCw className="h-3 w-3" aria-hidden />
      <span className="sr-only">config still says</span>
      {was}
    </span>
  );
}

/**
 * One container's workers, edited where they are read.
 *
 * Empty is a value, the same as on the Containers card: it means inherit, and
 * the placeholder says what from. So a container on its machine's number reads
 * muted and one with its own reads like any typed value — which is the whole
 * difference an operator needs to see down the column. A number typed is
 * kept as typed, even one equal to what it inherits: that is how a container
 * is pinned to fifty while its machine moves.
 *
 * Saved on blur, like the name template, and only when it changed.
 */
function InstanceWorkers({
  row,
  inherited,
  disabled,
  onSave,
  onInvalid,
}: {
  row: InstanceRow;
  inherited: number;
  disabled: boolean;
  onSave: (workers: number | null) => void;
  onInvalid: () => void;
}) {
  const own = row.ownWorkers === null ? "" : String(row.ownWorkers);
  const [value, setValue] = useState(own);
  // Back to what is stored after a save lands, or after somebody else's does.
  useEffect(() => setValue(own), [own]);

  function commit() {
    const typed = value.trim();
    if (typed === own) return;
    const next = typed === "" ? null : Number(typed);
    if (next !== null && (!Number.isInteger(next) || next < 1 || next > 50)) {
      setValue(own);
      onInvalid();
      return;
    }
    onSave(next);
  }

  return (
    <Input
      aria-label={`Workers for instance ${row.index}`}
      className="ml-auto h-8 w-16 text-right tabular-nums"
      inputMode="numeric"
      placeholder={String(inherited)}
      value={value}
      disabled={disabled}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        // Reverted without blurring. A blur from inside this handler runs the
        // commit with this render's value -- the one typed -- and so would
        // save exactly what Escape was pressed to throw away.
        if (event.key === "Escape") setValue(own);
      }}
    />
  );
}

export function HostInstancesTable({
  hostId,
  adopted,
  instances,
  inheritedWorkers,
  groups,
  defaultGroupId,
  nameTemplate,
  hostName,
  canOperate,
}: {
  hostId: string;
  /** Nothing is added before adoption; see `HostScaleForm`. */
  adopted: boolean;
  instances: InstanceRow[];
  /** What a container without its own number gets: its machine's, else Settings. */
  inheritedWorkers: number;
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
  // How many to add, and what each is configured for. Workers empty inherits,
  // so "one more like the others" is the button with nothing typed.
  const [addCount, setAddCount] = useState("1");
  const [addWorkers, setAddWorkers] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  // The index the next container would take, for the preview to be this
  // machine's next name rather than a generic example. The allocator fills the
  // lowest free index rather than appending, so this follows it.
  const taken = new Set(instances.map((row) => row.index));
  let nextIndex = 1;
  while (taken.has(nextIndex)) nextIndex += 1;
  const [error, setError] = useState<string | null>(null);
  const [doomed, setDoomed] = useState<{ row: InstanceRow; forget: boolean } | null>(null);

  function run(action: () => Promise<{ error?: string; reason?: string }>, onOk?: () => void) {
    setError(null);
    setMessage(null);
    start(async () => {
      const result = await action();
      if (result.error) setError(result.error);
      else {
        // Offline, say, which is not a failure but is worth being told.
        if (result.reason) setMessage(result.reason);
        onOk?.();
      }
    });
  }

  const parsedAddCount = Number(addCount);
  const addWorkersTyped = addWorkers.trim();
  const parsedAddWorkers = addWorkersTyped === "" ? null : Number(addWorkersTyped);
  const addValid =
    Number.isInteger(parsedAddCount) &&
    parsedAddCount >= 1 &&
    instances.length + parsedAddCount <= 64 &&
    (parsedAddWorkers === null ||
      (Number.isInteger(parsedAddWorkers) && parsedAddWorkers >= 1 && parsedAddWorkers <= 50));

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

      {canOperate && adopted ? (
        <div className="flex flex-wrap items-center gap-2 px-6 text-sm">
          <span className="text-muted-foreground">Add</span>
          <Input
            aria-label="How many containers to add"
            className="h-8 w-14 tabular-nums"
            inputMode="numeric"
            value={addCount}
            disabled={pending}
            onChange={(event) => setAddCount(event.target.value)}
          />
          <span className="text-muted-foreground">with</span>
          <Input
            aria-label="Workers each new container is configured for"
            className="h-8 w-16 tabular-nums"
            inputMode="numeric"
            // What it inherits when left empty, so the field reads as a
            // choice already made rather than one missing.
            placeholder={String(inheritedWorkers)}
            value={addWorkers}
            disabled={pending}
            onChange={(event) => setAddWorkers(event.target.value)}
          />
          <span className="text-muted-foreground">workers each</span>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !addValid}
            onClick={() =>
              run(
                () => addInstances(hostId, parsedAddCount, parsedAddWorkers),
                () => {
                  setAddCount("1");
                  setAddWorkers("");
                },
              )
            }
          >
            {pending ? "Adding…" : "Add"}
          </Button>
          <span className="text-xs text-muted-foreground">
            {addWorkersTyped === ""
              ? `Empty follows this machine's number, now ${inheritedWorkers}.`
              : "Their own number, kept when the machine's changes."}
          </span>
        </div>
      ) : null}

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
                    <div className="flex items-center justify-end gap-2">
                      {row.configBehind !== null ? <ConfigBehind was={row.configBehind} /> : null}
                      {canOperate ? (
                        <InstanceWorkers
                          row={row}
                          inherited={inheritedWorkers}
                          disabled={pending}
                          onSave={(workers) => run(() => setInstanceWorkers(row.id, workers))}
                          onInvalid={() => setError("Workers must be between 1 and 50.")}
                        />
                      ) : (
                        // Muted when inherited, the way the editable field's
                        // placeholder is, so both views say the same thing.
                        <span className={row.ownWorkers === null ? "text-muted-foreground" : ""}>
                          {row.workers}
                        </span>
                      )}
                    </div>
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
      {message ? <p className="px-6 pb-4 text-sm text-muted-foreground">{message}</p> : null}

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
