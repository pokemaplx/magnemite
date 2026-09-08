"use client";

import { useCallback, useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { Pencil } from "lucide-react";
import { loadRenameTargets, readNamesFromBoxes, renameDevices } from "@/actions/devices";
import {
  planFromNames,
  planRename,
  RENAME_TOKENS,
  type RenameOrder,
  type RenamePlan,
  type RenameTarget,
} from "@/lib/rename-pattern";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const ORDER_LABELS: Record<RenameOrder, string> = {
  table: "the order shown in the table",
  serial: "serial",
  name: "current name",
  created: "when it enrolled",
};

type Mode = "pattern" | "boxes";

/**
 * Naming many boxes at once.
 *
 * Two ways in, one preview: a pattern with a counter, and reading the name each
 * box's own MITM config already uses. Both end at the same `planRename` rules
 * and the same apply, so what the preview shows is what gets written.
 *
 * The targets are fetched when the dialog opens rather than passed as props.
 * The collision marking needs every box's name, and the settings page has no
 * device list — giving it one would ship the whole fleet's names on every
 * settings visit for a page that is otherwise about configuration.
 */
export function RenameDevicesDialog({
  source,
  orders,
  trigger,
  open: openProp,
  onOpenChange,
}: {
  source: { deviceIds: string[] } | { groupId: string };
  /** First entry is the default. The group card has no table to inherit. */
  orders: RenameOrder[];
  /** Omitted when the caller drives `open` itself — a menu item, typically. */
  trigger?: ReactNode;
  /**
   * Controlled open, for the callers that have no button to hang a trigger
   * on. A device page opens this from a dropdown menu item, and Radix
   * unmounts the menu on select, which takes any trigger inside it with it.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const [mode, setMode] = useState<Mode>("pattern");

  const [targets, setTargets] = useState<RenameTarget[] | null>(null);
  const [fleet, setFleet] = useState<{ id: string; name: string }[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [pattern, setPattern] = useState("");
  const [order, setOrder] = useState<RenameOrder>(orders[0] ?? "serial");
  const [startAt, setStartAt] = useState(1);
  const [step, setStep] = useState(1);

  const [found, setFound] = useState<Record<
    string,
    { name: string | null; reason?: string }
  > | null>(null);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const sourceKey = "groupId" in source ? source.groupId : source.deviceIds.join(",");

  // Load on open, and again if the selection changed underneath a dialog that
  // was closed and reopened.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setTargets(null);
    setLoadError(null);
    setFound(null);
    setMessage(null);
    void loadRenameTargets(source).then((result) => {
      if (!live) return;
      if (result.error || !result.targets) {
        setLoadError(result.error ?? "Could not load the boxes.");
        return;
      }
      setTargets(result.targets);
      setFleet(result.fleet ?? []);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sourceKey]);

  const plan: RenamePlan | null = useMemo(() => {
    if (!targets) return null;
    if (mode === "boxes") {
      return found ? planFromNames(targets, fleet, found) : null;
    }
    if (!pattern) return null;
    return planRename(targets, fleet, { pattern, order, startAt, step });
  }, [targets, fleet, mode, found, pattern, order, startAt, step]);

  const read = useCallback(() => {
    if (!targets) return;
    startTransition(async () => {
      setMessage(null);
      const result = await readNamesFromBoxes(targets.map((t) => t.id));
      if (result.error) {
        setMessage(result.error);
        return;
      }
      setFound(result.found ?? {});
      setMessage(result.message ?? null);
    });
  }, [targets]);

  const apply = useCallback(() => {
    if (!targets || !plan) return;
    startTransition(async () => {
      setMessage(null);
      const deviceIds = targets.map((t) => t.id);
      const result =
        mode === "boxes" && found
          ? await renameDevices({ deviceIds, names: found })
          : await renameDevices({ deviceIds, pattern, order, startAt, step });
      if (result.error) {
        setMessage(result.error);
        return;
      }
      setOpen(false);
    });
  }, [targets, plan, mode, found, pattern, order, startAt, step]);

  const counts = plan?.counts;
  const canApply = Boolean(plan && !plan.error && counts && counts.renamed > 0 && !pending);

  // One box is the same machinery wearing different words. A counter, an
  // order to apply it in and a step are all answers to "which box gets which
  // number", and with one box there is no such question — so the pattern
  // field becomes a name field and the three knobs go away. What stays is the
  // preview, which still has something to say: the collision check is against
  // the whole fleet, not against the selection.
  const single = targets?.length === 1;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}

      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Rename {targets ? `${targets.length} ` : ""}
            {targets?.length === 1 ? "device" : "devices"}
          </DialogTitle>
          <DialogDescription>
            Only the name in Magnemite changes. The config already on a box keeps the name it was
            written with until that box&apos;s MITM is next deployed.
          </DialogDescription>
        </DialogHeader>

        {loadError ? <p className="text-sm text-destructive">{loadError}</p> : null}
        {!targets && !loadError ? (
          <p className="text-sm text-muted-foreground">Loading the boxes…</p>
        ) : null}

        {targets ? (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(
                [
                  single
                    ? (["pattern", "Type it", "A name, or a pattern with tokens."] as const)
                    : (["pattern", "A pattern", "Number them into a scheme."] as const),
                  single
                    ? (["boxes", "From the box", "Adopt the name its config uses."] as const)
                    : (["boxes", "From the boxes", "Adopt the names their configs use."] as const),
                ] as const
              ).map(([id, label, hint]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={mode === id}
                  onClick={() => setMode(id)}
                  className={cn(
                    "flex flex-col gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors",
                    mode === id ? "border-primary bg-primary/10" : "border-border hover:bg-subtle",
                  )}
                >
                  <span className="text-sm font-medium">{label}</span>
                  <span className="text-xs text-muted-foreground">{hint}</span>
                </button>
              ))}
            </div>

            {mode === "pattern" ? (
              <>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="rename-pattern">{single ? "New name" : "Pattern"}</Label>
                  <Input
                    id="rename-pattern"
                    value={pattern}
                    onChange={(e) => setPattern(e.target.value)}
                    placeholder={single ? "living-room-01" : "{group}-{n:02}"}
                    className="font-mono"
                    autoFocus
                  />
                  <p className="text-xs text-muted-foreground">
                    {single ? (
                      <>
                        Plain text, or the same tokens the fleet uses:{" "}
                        {RENAME_TOKENS.filter((token) => token !== "n")
                          .map((token) => `{${token}}`)
                          .join(", ")}
                        . <span className="font-mono">{"{serial:4}"}</span> is the last four of the
                        serial.
                      </>
                    ) : (
                      <>
                        {RENAME_TOKENS.map((token) => `{${token}}`).join(", ")}.{" "}
                        <span className="font-mono">{"{n:03}"}</span> pads the counter to three
                        digits; <span className="font-mono">{"{serial:4}"}</span> is the last four
                        of the serial.
                      </>
                    )}
                  </p>
                </div>

                <div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-3", single && "hidden")}>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="rename-order">Number in order of</Label>
                    <Select
                      id="rename-order"
                      aria-label="Number in order of"
                      value={order}
                      onValueChange={(value) => setOrder(value as RenameOrder)}
                      options={orders.map((id) => ({ value: id, label: ORDER_LABELS[id] }))}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="rename-start">Start at</Label>
                    <Input
                      id="rename-start"
                      type="number"
                      value={startAt}
                      onChange={(e) => setStartAt(Number(e.target.value))}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="rename-step">Step</Label>
                    <Input
                      id="rename-step"
                      type="number"
                      min={1}
                      value={step}
                      onChange={(e) => setStep(Number(e.target.value))}
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" variant="secondary" onClick={read} disabled={pending}>
                  Read the names off {targets.length} box{targets.length === 1 ? "" : "es"}
                </Button>
                <span className="text-xs text-muted-foreground">
                  Runs one read per box. Offline boxes, and groups whose config has no field that is
                  exactly <span className="font-mono">{"{{device.name}}"}</span>, are skipped.
                </span>
              </div>
            )}

            {plan?.error ? <p className="text-sm text-destructive">{plan.error}</p> : null}

            {plan && !plan.error ? (
              <div className="overflow-hidden rounded-xl border border-border">
                <Table containerClassName="max-h-64">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Device</TableHead>
                      <TableHead>New name</TableHead>
                      <TableHead className="w-28" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {plan.rows.map((row) => (
                      <TableRow key={row.deviceId}>
                        <TableCell>
                          <div>{row.from}</div>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {row.to ? row.to : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell title={row.reason}>
                          {row.status === "skipped" ? (
                            <Badge variant="secondary">skipped</Badge>
                          ) : row.duplicate ? (
                            <Badge variant="warning">duplicate</Badge>
                          ) : row.status === "unchanged" ? (
                            <Badge variant="secondary">unchanged</Badge>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}

            {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
          </div>
        ) : null}

        <DialogFooter className="items-center justify-between sm:justify-between">
          <div className="text-xs text-muted-foreground">
            {counts ? (
              <>
                <div>
                  {counts.total} box{counts.total === 1 ? "" : "es"} · {counts.renamed} renamed
                  {counts.unchanged > 0 ? `, ${counts.unchanged} unchanged` : ""}
                  {counts.skipped > 0 ? `, ${counts.skipped} skipped` : ""}
                </div>
                {counts.duplicate > 0 ? (
                  <div>
                    {counts.duplicate} will share a name with another box. Nothing stops you — but
                    you will not tell them apart in the table or in an alert.
                  </div>
                ) : null}
                {counts.stale > 0 ? (
                  <div>
                    {counts.stale} write the name into a scanner config. That file keeps the old
                    name until the box&apos;s MITM is next deployed.
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={apply} disabled={!canApply}>
              <Pencil />
              {pending ? "Renaming…" : `Rename ${counts?.renamed ?? 0}`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
