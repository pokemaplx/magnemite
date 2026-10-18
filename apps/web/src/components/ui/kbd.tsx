"use client";

import { Fragment, useEffect, useState } from "react";
import { isMacPlatform, keyCaps, parseCombo } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

/**
 * Whether to draw ⌘ rather than Ctrl. Decided after mount, so the server and
 * the first client render agree on Ctrl and hydration stays quiet.
 */
export function useIsMac(): boolean {
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(isMacPlatform()), []);
  return mac;
}

/**
 * A shortcut drawn as key caps: `mod+k` is Ctrl K (⌘ K on a Mac), `g f` is the
 * two keys one after the other.
 */
export function Kbd({ keys, className }: { keys: string; className?: string }) {
  const mac = useIsMac();
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {parseCombo(keys).map((step, i) => (
        <Fragment key={i}>
          {keyCaps(step, mac).map((cap) => (
            <kbd
              key={cap}
              className={cn(
                "inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-subtle px-1",
                "font-sans text-[11px] font-medium leading-none text-muted-foreground",
              )}
            >
              {cap}
            </kbd>
          ))}
        </Fragment>
      ))}
    </span>
  );
}
