"use client";

import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { formatElapsed, type SetupView } from "@/lib/instance-setup";
import { cn } from "@/lib/utils";

/**
 * A container being set up, in place of its state badge: what it is doing,
 * how far along, and for how long. Hover it for the longer version.
 */
export function InstanceSetup({ view }: { view: SetupView }) {
  return (
    <div className="flex min-w-48 flex-col gap-1" title={view.detail}>
      <span
        className={cn(
          "flex items-center gap-1.5 text-xs",
          view.tone === "danger"
            ? "text-destructive"
            : view.tone === "warning"
              ? "text-warning"
              : "text-foreground",
        )}
      >
        {view.tone === "danger" ? (
          <X className="h-3 w-3 shrink-0" />
        ) : (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
        )}
        <span className="truncate">{view.label}</span>
      </span>
      <span className="flex items-center gap-2">
        <Progress
          value={view.percent}
          tone={view.tone === "danger" ? "danger" : view.tone === "warning" ? "warning" : "primary"}
          className="w-28"
        />
        <Elapsed since={view.since} />
      </span>
    </div>
  );
}

/**
 * Counting up every second, so a box mid-boot visibly has not stalled.
 *
 * Empty on the server render and until mounted: the server's clock is not the
 * browser's, and a first frame drawn from it would not hydrate.
 */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <span className="text-[11px] tabular-nums text-muted-foreground">
      {now === null ? "" : formatElapsed(now - Date.parse(since))}
    </span>
  );
}
