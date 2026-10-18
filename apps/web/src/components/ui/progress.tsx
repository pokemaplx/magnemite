import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Deliberately not the Radix primitive: this renders inside a table row a few
 * hundred times and a plain div keeps the fleet page cheap to re-render.
 */
export function Progress({
  value,
  className,
  tone = "primary",
}: {
  value: number;
  className?: string;
  tone?: "primary" | "success" | "warning" | "danger" | "muted";
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const bar = {
    primary: "bg-primary",
    warning: "bg-warning",
    success: "bg-success",
    danger: "bg-destructive",
    muted: "bg-muted-foreground",
  }[tone];

  return (
    <div
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-emphasis", className)}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn("h-full transition-[width] duration-500", bar)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
