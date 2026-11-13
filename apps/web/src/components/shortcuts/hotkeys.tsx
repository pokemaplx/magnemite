"use client";

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { ShortcutId } from "@/lib/shortcuts";

/**
 * What a bound key does. Returning `false` means "not mine after all" — no row
 * under the cursor, nothing selected — and the key goes on to do whatever it
 * would have done without us, scrolling the page included.
 *
 * `event` is null when the palette runs the shortcut rather than a key.
 */
export type HotkeyHandler = (event: KeyboardEvent | null) => boolean | void;

export type ShortcutsApi = {
  canOperate: boolean;
  register: (id: ShortcutId, handler: RefObject<HotkeyHandler>) => () => void;
  /** Runs what is bound to a shortcut, as though its key had been pressed. */
  run: (id: ShortcutId) => boolean;
  isBound: (id: ShortcutId) => boolean;
  /** The bound shortcuts that offer themselves to the palette, in registry order. */
  commands: () => ShortcutId[];
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setHelpOpen: Dispatch<SetStateAction<boolean>>;
  setSingleKeys: (on: boolean) => void;
};

export type ShortcutsState = { paletteOpen: boolean; helpOpen: boolean; singleKeys: boolean };

/**
 * Two contexts, so that opening the palette re-renders the palette and not
 * every table that has a key bound — those only need the stable half.
 */
export const ShortcutsContext = createContext<ShortcutsApi | null>(null);
export const ShortcutsStateContext = createContext<ShortcutsState>({
  paletteOpen: false,
  helpOpen: false,
  singleKeys: true,
});

/** The stable half: binding keys, running them, opening the palette and the help. */
export function useShortcuts(): ShortcutsApi {
  const api = useContext(ShortcutsContext);
  if (!api) throw new Error("useShortcuts needs a ShortcutsProvider above it.");
  return api;
}

export function useShortcutsState(): ShortcutsState {
  return useContext(ShortcutsStateContext);
}

/**
 * Bind a key for as long as the calling component is mounted (and `enabled`).
 *
 * The handler is read at the moment the key is pressed, so it sees the
 * component's current state without rebinding on every render. With no
 * provider above it does nothing, so a component that binds a key still
 * renders anywhere.
 */
export function useHotkey(
  id: ShortcutId,
  handler: HotkeyHandler,
  { enabled = true }: { enabled?: boolean } = {},
): void {
  const register = useContext(ShortcutsContext)?.register;
  const ref = useRef(handler);
  useLayoutEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!enabled || !register) return;
    return register(id, ref);
  }, [id, enabled, register]);
}
