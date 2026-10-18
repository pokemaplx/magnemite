"use client";

import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type SelectProps = {
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  name?: string;
  id?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
};

/**
 * The closed field, exported for the controls that have to sit beside a Select
 * and look like one -- a menu of checkboxes is not a Select, and should not
 * look like something else.
 */
export const SELECT_FIELD =
  "flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-input bg-card px-3 py-1 text-sm " +
  "transition-colors hover:border-border-emphasis focus-visible:border-border-emphasis focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring/15 disabled:cursor-not-allowed disabled:opacity-40";

/**
 * Apple's own pickers are the better control on their platforms — the iOS wheel
 * and the macOS popup are what people there expect — so those get the native
 * <select>. Everywhere else the native menu is unstyleable and looks foreign in
 * a dark UI, so we render the Radix one.
 *
 * The check runs after mount, so the server and the first client render agree
 * (both Radix) and hydration stays quiet.
 */
function useIsApple() {
  const [isApple, setIsApple] = React.useState(false);

  React.useEffect(() => {
    const ua = navigator.userAgent;
    // iPadOS reports as "Macintosh"; either way it is an Apple picker we want.
    setIsApple(/Macintosh|Mac OS X|iPhone|iPad|iPod/.test(ua));
  }, []);

  return isApple;
}

export function Select({
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder = "Select…",
  name,
  id,
  required,
  disabled,
  className,
  "aria-label": ariaLabel,
}: SelectProps) {
  const isApple = useIsApple();

  if (isApple) {
    return (
      <select
        id={id}
        name={name}
        required={required}
        disabled={disabled}
        aria-label={ariaLabel}
        {...(value !== undefined ? { value } : { defaultValue })}
        onChange={(e) => onValueChange?.(e.target.value)}
        className={cn(SELECT_FIELD, className)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <SelectPrimitive.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      name={name}
      required={required}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(SELECT_FIELD, "[&>span]:truncate", className)}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className={cn(
            "relative z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden",
            "rounded-lg border border-border bg-popover text-sm shadow-lg",
          )}
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={cn(
                  "relative flex cursor-pointer select-none items-center gap-2 rounded-sm py-1.5 pl-2 pr-8 outline-none",
                  "focus:bg-subtle data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
                )}
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-2">
                  <Check className="h-4 w-4" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
