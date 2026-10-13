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
 *
 * It says the boxes go too, and they do. This used to promise the opposite and
 * keep their rows, which was wrong in the same breath it was written: the same
 * sentence admitted a re-added machine mints fresh serials, so a kept row was
 * a box that could never come back — one permanently offline entry in the
 * fleet table per instance, left for somebody to delete by hand.
 */
export function DeleteHost({
  hostId,
  name,
  instances,
  boxes,
}: {
  hostId: string;
  name: string;
  instances: number;
  /**
   * How many of them ever enrolled, which is how many `Device` rows go. Not
   * the same as the instance count in either direction: one that never
   * enrolled has no row, and one that was removed still has its own.
   */
  boxes: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Spelled out rather than summarised, and assembled from the two counts
  // because they move independently: a machine can have containers and no
  // enrolled box, or no containers and boxes left from instances that were
  // removed. Saying "no containers to stop" while silently deleting four
  // boxes is the omission this dialog exists to prevent.
  const containerPart =
    instances > 0
      ? `Its ${instances} container${instances === 1 ? "" : "s"} and their /data go, and the machine is forgotten here.`
      : "The machine is forgotten here. It is running no containers for Magnemite to stop.";
  const boxPart =
    boxes > 0
      ? ` The ${boxes} box${boxes === 1 ? "" : "es"} that enrolled from it ${
          boxes === 1 ? "goes" : "go"
        } too, with ${boxes === 1 ? "its" : "their"} history — nothing here is recoverable, because a machine added again gets fresh serials and ${
          boxes === 1 ? "that row" : "those rows"
        } could never be matched to a container again. Any install in progress is cancelled first.`
      : "";
  const description = containerPart + boxPart;

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
        description={description}
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
