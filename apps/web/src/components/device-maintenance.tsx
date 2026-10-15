"use client";

import { useState, useTransition } from "react";
import { Wrench } from "lucide-react";
import { setDeviceMaintenance } from "@/actions/devices";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";

/** What you can park a box for. A week is the hub's own ceiling. */
const WINDOWS = [
  { minutes: 60, label: "1 hour" },
  { minutes: 240, label: "4 hours" },
  { minutes: 1440, label: "24 hours" },
  { minutes: 10080, label: "A week" },
];

/**
 * Park a box, or put it back.
 *
 * The dialog's job is to be honest about two things the operator cannot see
 * otherwise:
 *
 *  - **What stops and starts.** Entering runs the group's pre-install hook,
 *    which is what stops the scanner, and leaving runs the post-install hook.
 *    A group with no hooks parks the box with the scanner still running, which
 *    is a legitimate thing to want and a terrible thing to assume — so the
 *    result says which happened.
 *  - **That it ends by itself.** The window is the feature. A box parked and
 *    forgotten comes back on its own, which is the whole reason this is not a
 *    switch.
 */
export function DeviceMaintenance({
  deviceId,
  name,
  maintenanceUntil,
  open,
  onOpenChange,
}: {
  deviceId: string;
  name: string;
  /** ISO string while parked, null otherwise. */
  maintenanceUntil: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [chosen, setChosen] = useState(240);

  const parked = maintenanceUntil !== null && new Date(maintenanceUntil).getTime() > Date.now();

  function submit(minutes: number) {
    startTransition(async () => {
      const result = await setDeviceMaintenance(deviceId, minutes);
      if (result.error) {
        toast(result.error, "error");
        return;
      }
      // Two messages rather than one, because the hook's fate is a separate
      // fact from the window being set and the operator needs both.
      toast(
        minutes > 0
          ? `${name} is in maintenance until ${new Date(result.until!).toLocaleTimeString()}.`
          : `${name} is back in service.`,
      );
      if (result.hookNote) toast(result.hookNote, "error");
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{parked ? `${name} is in maintenance` : `Work on ${name}`}</DialogTitle>
          <DialogDescription>
            {parked ? (
              <>
                Until <strong>{new Date(maintenanceUntil!).toLocaleString()}</strong>. Monitoring
                rules, automatic rollouts, join installs and agent updates are all leaving it alone,
                and a rollout aimed at it is refused. Logs, Execute, screenshots and Reboot still
                work — they are the point.
              </>
            ) : (
              <>
                Nothing automatic touches it until the window closes: no rule acts on it, no
                automatic rollout targets it, and a rollout you aim at it is refused rather than
                queued. Its scanner is stopped now and started again when the window ends, using
                this group&rsquo;s install hooks.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {parked ? null : (
          <div className="flex flex-wrap gap-2">
            {WINDOWS.map((window) => (
              <Button
                key={window.minutes}
                variant={chosen === window.minutes ? "default" : "outline"}
                disabled={pending}
                onClick={() => setChosen(window.minutes)}
              >
                {window.label}
              </Button>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {parked ? (
            <Button disabled={pending} onClick={() => submit(0)}>
              <Wrench />
              {pending ? "Ending…" : "End maintenance"}
            </Button>
          ) : (
            <Button disabled={pending} onClick={() => submit(chosen)}>
              <Wrench />
              {pending ? "Parking…" : "Start maintenance"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
