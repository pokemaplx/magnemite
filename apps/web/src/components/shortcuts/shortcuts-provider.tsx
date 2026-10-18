"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useRouter } from "next/navigation";
import { NAV_LINKS, type NavLink } from "@/lib/nav";
import {
  SHORTCUT_IDS,
  isLetterKey,
  isMacPlatform,
  parseCombo,
  shortcutDef,
  type KeyStep,
  type ShortcutId,
} from "@/lib/shortcuts";
import { CommandPalette } from "@/components/shortcuts/command-palette";
import {
  ShortcutsContext,
  ShortcutsStateContext,
  useHotkey,
  useShortcuts,
  type HotkeyHandler,
  type ShortcutsApi,
  type ShortcutsState,
} from "@/components/shortcuts/hotkeys";
import { ShortcutsDialog } from "@/components/shortcuts/shortcuts-dialog";

type Binding = { token: number; handler: RefObject<HotkeyHandler> };

const SINGLE_KEYS_KEY = "magnemite:single-key-shortcuts";

/** How long `g` waits for the second key. */
const SEQUENCE_MS = 1000;

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "OS"]);

const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

/**
 * Widgets that take keys for themselves. The one that bites is the closed Radix
 * Select trigger: it does typeahead while closed, so with the Group picker
 * focused on the device page, `e` would open Execute *and* move the box to the
 * first group starting with "e".
 */
const KEY_WIDGETS = [
  "combobox",
  "listbox",
  "option",
  "menu",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "radiogroup",
  "radio",
  "tablist",
  "tab",
  "slider",
  "spinbutton",
  "textbox",
  "searchbox",
]
  .map((role) => `[role="${role}"]`)
  .join(",");

/**
 * Something open on top of the page. Its keys are its own: Escape closes it,
 * letters go to its fields. Radix unmounts closed content (nothing in the kit
 * animates out), so being in the DOM is the whole test.
 */
const LAYERS = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  '[role="listbox"]',
].join(",");

/** Where Enter already means something. */
const CONTROLS =
  'a,button,input,select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="switch"],[role="menuitem"],[role="option"],[role="tab"]';

function takesKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type);
  return target.closest(KEY_WIDGETS) !== null;
}

type Press = {
  key: string;
  letter: boolean;
  mod: boolean;
  /** The other of Ctrl and ⌘, which no binding uses — somebody else's shortcut. */
  otherMod: boolean;
  shift: boolean;
  alt: boolean;
};

function readPress(event: KeyboardEvent, mac: boolean): Press {
  // AltGr arrives as Ctrl+Alt on Windows, and it is how `/` and `?` are typed
  // on an ABNT2 laptop without the extra key — so it has to read as no
  // modifier at all, or those two would never fire on exactly that keyboard.
  const altGraph = event.getModifierState?.("AltGraph") ?? false;
  const ctrl = event.ctrlKey && !altGraph;
  const letter = isLetterKey(event.key);
  let key = event.key;
  if (key.length > 1) key = key.toLowerCase();
  else if (letter) key = key.toLowerCase();
  return {
    key,
    letter,
    mod: mac ? event.metaKey : ctrl,
    otherMod: mac ? ctrl : event.metaKey,
    shift: event.shiftKey,
    alt: event.altKey && !altGraph,
  };
}

function matches(step: KeyStep, press: Press): boolean {
  if (press.otherMod || step.mod !== press.mod || step.alt !== press.alt) return false;
  if (step.key !== press.key) return false;
  // A symbol takes whatever shift it took to type it — `?` is a shifted key on
  // most layouts. A letter or a named key does not: shift+r is not r, and Caps
  // Lock, which changes the letter and not the shift, must not turn one into
  // the other.
  const symbol = press.key.length === 1 && !press.letter;
  return symbol || step.shift === press.shift;
}

/**
 * The one keyboard listener in the dashboard.
 *
 * Components bind keys with `useHotkey`; this decides whether a key press is a
 * shortcut at all — not while typing, not under an open dialog — and hands it
 * to the newest binding for it. Mounted around the dashboard together with the
 * two things it opens: the palette and the `?` dialog.
 */
export function ShortcutsProvider({
  canOperate,
  children,
}: {
  canOperate: boolean;
  children: ReactNode;
}) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [singleKeys, setSingleKeysState] = useState(true);

  // A stack per key, newest last. Removing by token rather than popping is
  // what keeps the binding underneath intact when one in the middle unmounts —
  // and StrictMode mounts everything twice.
  const bindings = useRef(new Map<ShortcutId, Binding[]>());
  const nextToken = useRef(0);
  const singleKeysRef = useRef(singleKeys);
  const canOperateRef = useRef(canOperate);

  useEffect(() => {
    singleKeysRef.current = singleKeys;
  }, [singleKeys]);
  useEffect(() => {
    canOperateRef.current = canOperate;
  }, [canOperate]);

  // Read after mount: the server cannot know the stored preference.
  useEffect(() => {
    try {
      setSingleKeysState(window.localStorage.getItem(SINGLE_KEYS_KEY) !== "off");
    } catch {
      // Storage refused — private mode, blocked site data. The default stands.
    }
  }, []);

  const setSingleKeys = useCallback((on: boolean) => {
    setSingleKeysState(on);
    try {
      window.localStorage.setItem(SINGLE_KEYS_KEY, on ? "on" : "off");
    } catch {
      // Remembered for this visit only.
    }
  }, []);

  const register = useCallback((id: ShortcutId, handler: RefObject<HotkeyHandler>) => {
    const token = nextToken.current++;
    bindings.current.set(id, [...(bindings.current.get(id) ?? []), { token, handler }]);
    return () => {
      const rest = (bindings.current.get(id) ?? []).filter((binding) => binding.token !== token);
      if (rest.length > 0) bindings.current.set(id, rest);
      else bindings.current.delete(id);
    };
  }, []);

  const isBound = useCallback((id: ShortcutId) => {
    if (shortcutDef(id).operator && !canOperateRef.current) return false;
    return (bindings.current.get(id)?.length ?? 0) > 0;
  }, []);

  const fire = useCallback(
    (id: ShortcutId, event: KeyboardEvent | null): boolean => {
      const stack = bindings.current.get(id);
      if (!stack || !isBound(id)) return false;
      return stack[stack.length - 1]!.handler.current(event) !== false;
    },
    [isBound],
  );

  const run = useCallback((id: ShortcutId) => fire(id, null), [fire]);

  const commands = useCallback(
    () => SHORTCUT_IDS.filter((id) => shortcutDef(id).command && isBound(id)),
    [isBound],
  );

  useEffect(() => {
    let pending: { press: Press; timer: number } | null = null;
    const clearPending = () => {
      if (!pending) return;
      window.clearTimeout(pending.timer);
      pending = null;
    };

    function onKeyDown(event: KeyboardEvent) {
      // `key` is missing on the keydown Chrome fires when it autofills a field.
      if (typeof event.key !== "string" || MODIFIER_KEYS.has(event.key)) return;
      if (event.defaultPrevented || event.isComposing) return;

      const press = readPress(event, isMacPlatform());
      const typing = takesKeys(event.target);
      const layers = Array.from(document.querySelectorAll(LAYERS));
      const paletteOnly =
        layers.length > 0 && layers.every((layer) => layer.closest("[data-palette]") !== null);

      if (pending) {
        const first = pending.press;
        clearPending();
        if (typing || layers.length > 0) return;
        // Swallowed whether or not it finishes a sequence: g and then a key
        // that is not one is a slip, and the second key acting on its own —
        // x ticking a row — would be a surprise.
        event.preventDefault();
        for (const id of SHORTCUT_IDS) {
          if (!isBound(id)) continue;
          for (const combo of shortcutDef(id).keys) {
            const steps = parseCombo(combo);
            if (steps.length === 2 && matches(steps[0]!, first) && matches(steps[1]!, press)) {
              fire(id, event);
              return;
            }
          }
        }
        return;
      }

      for (const id of SHORTCUT_IDS) {
        if (!isBound(id)) continue;
        const def = shortcutDef(id);
        for (const combo of def.keys) {
          const steps = parseCombo(combo);
          const first = steps[0]!;
          if (!matches(first, press)) continue;

          if (first.mod) {
            // Over a dialog the only chord that works is the one closing the
            // palette; opening it over Execute would stack two focus traps.
            if (layers.length > 0 && !(paletteOnly && id === "palette")) continue;
          } else if (!singleKeysRef.current || typing || layers.length > 0) {
            continue;
          }
          if (event.repeat && !def.repeat) continue;
          if (
            first.key === "enter" &&
            event.target instanceof Element &&
            event.target.closest(CONTROLS)
          ) {
            continue;
          }

          if (steps.length > 1) {
            event.preventDefault();
            pending = { press, timer: window.setTimeout(clearPending, SEQUENCE_MS) };
            return;
          }

          // Prevented synchronously, before the handler's state lands: the
          // dialog a key opens focuses its own field, and without this the key
          // that opened it would be typed into it — `r` arriving as an "r" in
          // the rename pattern.
          if (fire(id, event)) {
            event.preventDefault();
            return;
          }
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", clearPending);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", clearPending);
      clearPending();
    };
  }, [fire, isBound]);

  const api = useMemo<ShortcutsApi>(
    () => ({
      canOperate,
      register,
      run,
      isBound,
      commands,
      setPaletteOpen,
      setHelpOpen,
      setSingleKeys,
    }),
    [canOperate, register, run, isBound, commands, setSingleKeys],
  );

  const state = useMemo<ShortcutsState>(
    () => ({ paletteOpen, helpOpen, singleKeys }),
    [paletteOpen, helpOpen, singleKeys],
  );

  return (
    <ShortcutsContext.Provider value={api}>
      <ShortcutsStateContext.Provider value={state}>
        {children}
        <GlobalHotkeys />
        <CommandPalette />
        <ShortcutsDialog />
      </ShortcutsStateContext.Provider>
    </ShortcutsContext.Provider>
  );
}

function GlobalHotkeys() {
  const { setPaletteOpen, setHelpOpen } = useShortcuts();
  useHotkey("palette", () => setPaletteOpen((open) => !open));
  useHotkey("help", () => setHelpOpen(true));
  return NAV_LINKS.map((link) => <NavHotkey key={link.href} link={link} />);
}

function NavHotkey({ link }: { link: NavLink }) {
  const router = useRouter();
  useHotkey(link.shortcut, () => router.push(link.href));
  return null;
}
