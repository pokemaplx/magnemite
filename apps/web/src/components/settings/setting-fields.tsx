"use client";

import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The three pieces a settings card is built from.
 *
 * Shared because the Hub and Monitoring cards are the same shape — a dozen
 * numbers each, in groups, with a unit beside them — and had grown two copies
 * of it that were already drifting apart in padding and label style.
 */

/**
 * A named block of settings that only mean anything together.
 *
 * A dozen numbers in one flat grid is a wall: the reboot grace and the history
 * window have nothing to do with each other, and reading them in sequence
 * suggests they do. The heading is what turns a list into four short answers.
 */
export function SettingGroup({
  title,
  hint,
  children,
}: {
  title: string;
  /** Only worth a line when the grouping itself needs explaining. */
  hint?: string;
  children: ReactNode;
}) {
  // A div rather than a fieldset: a legend does not take part in the layout of
  // a flex or grid parent, and the heading has to sit above the grid.
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h4>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </div>
  );
}

/** One number, its unit and what a wrong value costs. */
export function NumberField({
  name,
  label,
  value,
  min,
  max,
  step,
  hint,
  unit = "seconds",
  disabled,
  onValueChange,
}: {
  name: string;
  label: string;
  value: number;
  min: number;
  max?: number;
  /**
   * Browsers validate against this, and the default is 1 — so a field that is
   * legitimately fractional (gigabytes, where 2.5 is a real answer) refuses
   * what the operator typed unless it says so.
   */
  step?: number | "any";
  hint: ReactNode;
  unit?: string;
  disabled: boolean;
  /**
   * Mirrors what is typed, for the fields other fields are measured against.
   * The input stays uncontrolled — this only lets a sibling's hint name the
   * floor as it moves, instead of after a save the server turns down.
   */
  onValueChange?: (value: number) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Suffixed suffix={unit}>
        <Input
          id={name}
          name={name}
          type="number"
          min={min}
          max={max}
          step={step}
          defaultValue={value}
          disabled={disabled}
          onChange={
            onValueChange
              ? (event) => {
                  const parsed = Number(event.target.value);
                  if (Number.isFinite(parsed)) onValueChange(parsed);
                }
              : undefined
          }
        />
      </Suffixed>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * The unit beside the number rather than inside the label.
 *
 * "Unreachable after · seconds" reads as one thing; "Unreachable after
 * (seconds)" reads as a label that had to apologise for itself, and it made
 * every label in the grid a different length.
 */
export function Suffixed({ suffix, children }: { suffix: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">{children}</div>
      <span className="shrink-0 text-xs text-muted-foreground">{suffix}</span>
    </div>
  );
}
