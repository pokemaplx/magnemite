"use client";

import { useTransition } from "react";
import { CheckCircle2, Loader2, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dismissBoxEnroll } from "@/actions/boxes";

/**
 * Hardware boxes partway through being added over adb.
 *
 * Shown on the fleet rather than on a page of its own, because what it is
 * reporting is a box that is *about* to be in this list. The row disappears
 * by itself when the box dials in — WAITING is the gap between adb finishing
 * and the box finishing its reboot, and it is the state an operator most
 * needs to be able to see, since nothing else distinguishes "rebooting" from
 * "never coming back".
 */

export type EnrollingRow = {
  id: string;
  address: string;
  serial: string;
  state: "RUNNING" | "WAITING" | "DONE" | "FAILED";
  error: string | null;
  steps: { name: string; ok: boolean; detail: string }[];
  relayName: string | null;
};

export function EnrollingBanner({
  rows,
  canOperate,
}: {
  rows: EnrollingRow[];
  canOperate: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border bg-card/50 p-3">
      <p className="text-sm font-medium">
        {rows.length} box{rows.length === 1 ? "" : "es"} being added
      </p>
      {rows.map((row) => (
        <EnrollingItem key={row.id} row={row} canOperate={canOperate} />
      ))}
    </div>
  );
}

function EnrollingItem({ row, canOperate }: { row: EnrollingRow; canOperate: boolean }) {
  const [pending, start] = useTransition();

  // The last step is what it is doing now, or what it stopped on. More useful
  // than the state alone, which cannot tell "pushing 5 MB over wifi" from
  // "stuck".
  const last = row.steps.at(-1);
  const detail =
    row.state === "FAILED"
      ? (row.error ?? "failed")
      : row.state === "WAITING"
        ? "installed — waiting for it to reboot and dial in"
        : last
          ? `${last.name}${last.detail ? `: ${last.detail}` : ""}`
          : "starting";

  return (
    <div className="flex items-start gap-2 text-sm">
      {row.state === "FAILED" ? (
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      ) : row.state === "WAITING" ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      ) : (
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <span className="font-mono">{row.address}</span>
        {row.relayName ? (
          <span className="text-muted-foreground"> · via {row.relayName}</span>
        ) : null}
        <p
          className={`truncate text-xs ${
            row.state === "FAILED" ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {detail}
        </p>
      </div>
      {/* Only on a run that has stopped. Dismissing one still going would
          leave the process writing progress to a row that is gone. */}
      {canOperate && (row.state === "FAILED" || row.state === "DONE") ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => start(() => void dismissBoxEnroll(row.id))}
          aria-label={`Dismiss ${row.address}`}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
