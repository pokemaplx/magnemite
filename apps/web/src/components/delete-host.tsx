"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteHost } from "@/actions/hosts";

/**
 * Take a machine out of the fleet.
 *
 * Asks twice, and the second ask is typing the name. That is not ceremony: a
 * click here stops containers on a VPS and then removes the only record that
 * they were ever there, so the gesture is deliberately one you cannot make
 * while reading something else.
 *
 * What it says it does is what the action does, in order — containers down,
 * config removed, rows deleted — because the middle one is the part nobody
 * would guess and the part that decides whether the machine can be added
 * again afterwards.
 */
export function DeleteHost({
  hostId,
  name,
  instances,
}: {
  hostId: string;
  name: string;
  instances: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive"
        disabled={pending}
        onClick={() => {
          setTyped("");
          setError(null);
          setOpen(true);
        }}
      >
        Remove this machine
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setError(null);
        }}
        title={`Remove ${name} from the fleet?`}
        description={
          instances > 0
            ? `Its ${instances} container${instances === 1 ? "" : "s"} and their /data go, and the machine is forgotten here. The boxes that enrolled from them keep their rows and their history, but their data on this machine does not: a machine added again gets new serials, and a kept volume could never be matched to one of them again.`
            : "The machine is forgotten here. It is running no containers for Magnemite to stop."
        }
        confirmLabel="Remove it"
        pendingLabel="Removing…"
        pending={pending}
        error={error}
        onConfirm={() => {
          start(async () => {
            const result = await deleteHost(hostId, typed);
            if (result.error) {
              setError(result.error);
              return;
            }
            setOpen(false);
            // The warning matters more than the navigation: it is the case
            // where the containers are still running on a machine nothing is
            // watching any more.
            if (result.warning) window.alert(result.warning);
            router.push("/hosts");
          });
        }}
      >
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Its agent is stopped and its <span className="font-mono">/etc/magnemite/host.json</span>{" "}
            removed, which is what lets the same machine be added again later — otherwise it comes
            back claiming a serial this hub no longer has a row for.
          </p>
          <Label htmlFor="confirm-name" className="text-xs">
            Type <span className="font-mono text-foreground">{name}</span> to confirm
          </Label>
          <Input
            id="confirm-name"
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value);
              setError(null);
            }}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        </div>
      </ConfirmDialog>
    </>
  );
}
