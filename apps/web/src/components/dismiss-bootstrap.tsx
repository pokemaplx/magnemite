"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { dismissBootstrap } from "@/actions/hosts";

/**
 * Takes one provisioning off the Machines page.
 *
 * The record only — the machine itself is never touched. What it costs is said
 * in the confirmation, and it is said the same way whatever the row's state,
 * because the state is not what decides the risk: this row is what adopts a
 * machine and brings its containers up when it dials in, and `claimBootstrap`
 * finds it by serial or silently does nothing.
 *
 * A failed run is not a safe exception to that. It may have got further than
 * it managed to report — the steps are written per line and a lost write
 * leaves the row showing an earlier stage than the script reached — so a run
 * that reads as having stopped at `docker` may have installed the agent, and
 * that machine can dial in hours later, after the reboot a kernel module
 * needed.
 *
 * The dialog stays open on a refusal, which is what `ConfirmDialog`'s `error`
 * is for. This action has a refusal an operator reaches by an ordinary click —
 * a run that is still genuinely going — and closing on it would read as the
 * button being broken rather than as the answer being no.
 */
export function DismissBootstrap({ id, name }: { id: string; name: string }) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <Button variant="ghost" size="sm" disabled={pending} onClick={() => setOpen(true)}>
        Dismiss
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setError(null);
        }}
        title={`Dismiss the provisioning of ${name}?`}
        description={
          // The same warning whatever the state, because the state is not what
          // decides the risk: this row is what adopts a machine and brings its
          // containers up when it dials in, and a failed run may have got
          // further than it managed to report — far enough to have installed
          // the agent. If that machine ever turns up, it enrols and then sits
          // there, adopted by nobody.
          "The record goes; the machine is not touched. But this row is also what adopts that machine and brings its containers up if it ever dials in — so after this, a machine that turns up later is yours to adopt and scale by hand from its page. The enrollment token minted for the run stays in Settings → Enrollment until it expires, a week after it was minted; revoke it there to end it now."
        }
        confirmLabel="Dismiss it"
        pendingLabel="Dismissing…"
        pending={pending}
        error={error}
        onConfirm={() => {
          setError(null);
          start(async () => {
            const result = await dismissBootstrap(id);
            // Closed only on success. A refusal — a run that is still going —
            // has to be read where it was asked for, not beside a button the
            // dialog has already left.
            if (result.error) setError(result.error);
            else setOpen(false);
          });
        }}
      />
    </>
  );
}
