"use client";

import { useCallback, useRef, type Ref } from "react";
import { Search, X } from "lucide-react";
import { useHotkey } from "@/components/shortcuts/hotkeys";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  className,
  inputRef,
  shortcut = false,
  "aria-label": ariaLabel = "Search",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** For callers that need the field itself. */
  inputRef?: Ref<HTMLInputElement>;
  /**
   * Whether `/` jumps here. One per page — the page's main search — or two
   * boxes on the same page would fight over the key.
   */
  shortcut?: boolean;
  "aria-label"?: string;
}) {
  const own = useRef<HTMLInputElement | null>(null);

  useHotkey(
    "search",
    () => {
      own.current?.focus();
      own.current?.select();
    },
    { enabled: shortcut },
  );

  const setRef = useCallback(
    (node: HTMLInputElement | null) => {
      own.current = node;
      if (typeof inputRef === "function") inputRef(node);
      else if (inputRef) inputRef.current = node;
    },
    [inputRef],
  );

  return (
    <div className={cn("relative min-w-56 flex-1", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={setRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Back out of the field the way `/` came in, so the page's keys work
          // again without reaching for the mouse.
          if (shortcut && e.key === "Escape") e.currentTarget.blur();
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={cn("pl-8", (value || shortcut) && "pr-8")}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : shortcut ? (
        <Kbd
          keys="/"
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 max-sm:hidden"
        />
      ) : null}
    </div>
  );
}
