"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Loader2, Plus, Radar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Switch } from "@/components/ui/switch";
import { boxScan, enrollBoxes, scanForBoxes } from "@/actions/boxes";
import type { BoxCandidate } from "@/lib/hub";

/**
 * Adding hardware boxes, from the moment adb can reach them.
 *
 * Two steps, because unlike a machine you do not know a box's address the way
 * you know a VPS's: scan, then pick. What the scan reports is what the box
 * said about itself, including the two things that decide whether it can be
 * enrolled at all — whether adb is authorised, and whether `su` works.
 *
 * No credential anywhere. adb's key is the hub's and never leaves it; the
 * enrollment tokens are minted per box inside the run.
 */
export function AddBoxDialog({
  groups,
  machines,
}: {
  groups: { id: string; name: string }[];
  /** Online machines, which are the only things that can relay. */
  machines: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [addresses, setAddresses] = useState("");
  /** "" is the hub itself. Controlled so a failed scan does not lose it. */
  const [relayId, setRelayId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [reboot, setReboot] = useState(true);
  const [reprovision, setReprovision] = useState(false);

  const [scanId, setScanId] = useState<string | null>(null);
  const [found, setFound] = useState<BoxCandidate[] | null>(null);
  const [progress, setProgress] = useState<{ probed: number; total: number } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  /**
   * Polls the scan.
   *
   * In an effect keyed on the id rather than a loop inside the submit
   * handler, so closing the dialog mid-sweep stops the polling instead of
   * leaving it running against a component nobody is looking at.
   */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!scanId || !open) return;
    let cancelled = false;

    const poll = async () => {
      const { scan, error: err } = await boxScan(scanId);
      if (cancelled) return;
      if (err) {
        setError(err);
        setScanId(null);
        return;
      }
      if (!scan) return;
      setProgress({ probed: scan.probed, total: scan.total });
      if (!scan.done) {
        timer.current = setTimeout(poll, 1500);
        return;
      }
      setScanId(null);
      if (scan.error) {
        setError(scan.error);
        return;
      }
      setFound(scan.found);
      // Pre-tick everything that can actually be enrolled, because that is
      // what the operator meant by scanning. The ones that cannot say why.
      setPicked(new Set(scan.found.filter((c) => c.eligible).map((c) => c.address)));
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [scanId, open]);

  function scan() {
    setError(null);
    setFound(null);
    setPicked(new Set());
    setProgress(null);
    start(async () => {
      const result = await scanForBoxes({ addresses, relayDeviceId: relayId || null });
      if (result.error) setError(result.error);
      else if (result.id) {
        setScanId(result.id);
        setProgress({ probed: 0, total: result.total ?? 0 });
      }
    });
  }

  function enroll() {
    setError(null);
    const targets = (found ?? []).filter((c) => picked.has(c.address));
    start(async () => {
      const result = await enrollBoxes({
        targets,
        desiredGroupId: groupId || null,
        relayDeviceId: relayId || null,
        reboot,
        reprovision,
        names,
      });
      if (result.error) setError(result.error);
      else {
        setOpen(false);
        setFound(null);
        setPicked(new Set());
        setNames({});
      }
    });
  }

  const scanning = scanId !== null;
  const eligible = (found ?? []).filter((c) => c.eligible).length;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Plus className="mr-1.5 h-4 w-4" />
          Add boxes
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add boxes over adb</DialogTitle>
          <DialogDescription>
            Each box needs network adb on, Magisk installed, and <code>su</code> granted to shell.
            It is given the agent and its own enrollment token, then reboots and dials in on its own
            — after that nothing ever reaches it again.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="box-addresses">Addresses</Label>
            <textarea
              id="box-addresses"
              value={addresses}
              onChange={(e) => setAddresses(e.target.value)}
              rows={3}
              spellCheck={false}
              placeholder={"192.168.1.10\n192.168.1.11:5555\n192.168.1.0/24"}
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              One per line. A range up to /22 is swept for anything answering on 5555.
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="box-relay">Reach them from</Label>
            <Select
              id="box-relay"
              aria-label="Which host runs adb against the boxes"
              value={relayId}
              onValueChange={setRelayId}
              disabled={scanning || pending}
              placeholder="The hub itself"
              options={[
                { value: "", label: "The hub itself" },
                ...machines.map((m) => ({ value: m.id, label: m.name })),
              ]}
            />
            {/* The thing that makes every first attempt from a hosted hub a
                silent two-second timeout per address, if nobody says it. */}
            <p className="text-xs text-muted-foreground">
              {relayId
                ? "That machine runs adb on its own LAN and reports back over the socket it already holds."
                : "Only works if the hub shares a network with the boxes. A hub on a VPS cannot reach 192.168.x.x — pick a machine on their LAN instead."}
            </p>
          </div>

          <div>
            <Button type="button" variant="outline" onClick={scan} disabled={scanning || pending}>
              {scanning ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Radar className="mr-1.5 h-4 w-4" />
              )}
              {scanning
                ? `Scanning ${progress ? `${progress.probed}/${progress.total}` : ""}…`
                : "Scan"}
            </Button>
          </div>

          {found ? (
            found.length === 0 ? (
              <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                Nothing answered on 5555. Network adb has to be on before a box can be found.
              </p>
            ) : (
              <div className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-lg border p-1">
                {found.map((c) => {
                  const on = picked.has(c.address);
                  const selectable = c.eligible || reprovision;
                  return (
                    <label
                      key={c.address}
                      className={`flex items-start gap-3 rounded-md px-2 py-2 text-sm ${
                        selectable ? "hover:bg-muted/50" : "opacity-60"
                      }`}
                    >
                      <Checkbox
                        checked={on}
                        disabled={!selectable}
                        onCheckedChange={(value) => {
                          const next = new Set(picked);
                          if (value) next.add(c.address);
                          else next.delete(c.address);
                          setPicked(next);
                        }}
                        className="mt-0.5"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-mono">{c.address}</span>
                          <span className="truncate text-muted-foreground">
                            {[c.manufacturer, c.model].filter(Boolean).join(" ") || "unknown"}
                          </span>
                        </div>
                        {/* Why it cannot be taken, in the place the decision
                            is being made rather than in a failed run later. */}
                        {c.blockedBy ? (
                          <p className="text-xs text-warning">{c.blockedBy}</p>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            {c.abi || "unknown abi"}
                            {c.sdk ? ` · SDK ${c.sdk}` : ""} ·{" "}
                            {c.serialSource === "MINTED" ? (
                              <span className="text-warning">
                                new serial {c.serial} — {c.serialReason}
                              </span>
                            ) : (
                              <>serial {c.reportedSerial}</>
                            )}
                          </p>
                        )}
                        {selectable && on ? (
                          <Input
                            value={names[c.address] ?? ""}
                            onChange={(e) => setNames({ ...names, [c.address]: e.target.value })}
                            placeholder="Name (optional)"
                            className="mt-1.5 h-7 text-xs"
                            onClick={(e) => e.preventDefault()}
                          />
                        ) : null}
                      </div>
                    </label>
                  );
                })}
              </div>
            )
          ) : null}

          {found && found.length > 0 ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="box-group">Group</Label>
                <Select
                  id="box-group"
                  aria-label="Group the new boxes enrol into"
                  value={groupId}
                  onValueChange={setGroupId}
                  disabled={pending}
                  // Radix reads "" as *no value*, so this is what the closed
                  // field says while nothing is picked.
                  placeholder="No group"
                  options={[
                    { value: "", label: "No group" },
                    ...groups.map((g) => ({ value: g.id, label: g.name })),
                  ]}
                />
                <p className="text-xs text-muted-foreground">
                  Chosen now because the box enrolls by itself after the reboot — by the time its
                  page exists it already has its group&apos;s MITM config.
                </p>
              </div>

              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  Reboot after installing
                  <span className="block text-xs text-muted-foreground">
                    Magisk stages the module and swaps it on reboot, so until it restarts nothing is
                    running.
                  </span>
                </span>
                <Switch checked={reboot} onCheckedChange={setReboot} />
              </label>

              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  Replace an existing agent
                  <span className="block text-xs text-muted-foreground">
                    Overwrites the config on a box that is already enrolled. It keeps its serial, so
                    it keeps its row and its history.
                  </span>
                </span>
                <Switch checked={reprovision} onCheckedChange={setReprovision} />
              </label>
            </>
          ) : null}

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={enroll}
            disabled={pending || scanning || picked.size === 0}
          >
            {pending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            {picked.size > 0 ? `Enroll ${picked.size}` : "Enroll"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
