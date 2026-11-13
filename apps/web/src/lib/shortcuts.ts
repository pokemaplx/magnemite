/**
 * Every keyboard shortcut in the dashboard, in one place.
 *
 * The `?` dialog, the hints in the menus and the command palette all read this
 * list, so a key cannot be bound in one place and documented as something else
 * in another. A shortcut only does anything while a component has registered a
 * handler for it — `useHotkey` — which is how one key can mean "the box on this
 * page" on a device page and "the row under the cursor" in the Fleet.
 *
 * Keys are written the way they are matched:
 *
 * - `mod` is ⌘ on a Mac and Ctrl everywhere else.
 * - A letter is the letter, whatever Caps Lock says; `shift+r` is a different
 *   key from `r`.
 * - A symbol (`?`, `/`, `,`, `[`) is the character typed, whatever it took to
 *   type it — on a Brazilian keyboard `?` is AltGr+W on some laptops.
 * - A space separates the steps of a sequence: `g f` is g, then f.
 *
 * Nothing here uses `'`, `` ` ``, `~` or `^`: they are dead keys on ABNT2 and
 * arrive as "Dead" rather than as themselves.
 */

export type ShortcutScope = "global" | "navigation" | "fleet" | "device";

type ShortcutDef = {
  /** Alternatives; the first is the one shown in menus. */
  keys: readonly string[];
  label: string;
  scope: ShortcutScope;
  /** Changes the fleet, so it is neither bound nor listed for a viewer. */
  operator?: boolean;
  /** Offered in the palette's "On this page" group while it is bound. */
  command?: boolean;
  /** Keeps firing while the key is held — moving a cursor, not opening dialogs. */
  repeat?: boolean;
};

export const SHORTCUTS = {
  palette: { keys: ["mod+k"], label: "Open the command palette", scope: "global" },
  help: { keys: ["?"], label: "Show keyboard shortcuts", scope: "global" },
  search: { keys: ["/"], label: "Search this page", scope: "global", command: true },
  sidebar: {
    keys: ["["],
    label: "Collapse or expand the sidebar",
    scope: "global",
  },

  "nav.fleet": { keys: ["g f"], label: "Fleet", scope: "navigation" },
  "nav.hosts": { keys: ["g m"], label: "Machines", scope: "navigation" },
  "nav.rollouts": { keys: ["g r"], label: "Rollouts", scope: "navigation" },
  "nav.versions": { keys: ["g v"], label: "Versions", scope: "navigation" },
  "nav.manual": { keys: ["g d"], label: "Manual deploy", scope: "navigation" },
  "nav.monitoring": { keys: ["g o"], label: "Monitoring", scope: "navigation" },
  "nav.status": { keys: ["g s"], label: "Status", scope: "navigation" },
  "nav.settings": { keys: ["g ,"], label: "Settings", scope: "navigation" },

  "fleet.down": {
    keys: ["j", "arrowdown"],
    label: "Next device",
    scope: "fleet",
    repeat: true,
  },
  "fleet.up": { keys: ["k", "arrowup"], label: "Previous device", scope: "fleet", repeat: true },
  "fleet.open": { keys: ["enter", "o"], label: "Open the device", scope: "fleet" },
  "fleet.select": { keys: ["x"], label: "Select the device", scope: "fleet", operator: true },
  "fleet.selectPage": {
    keys: ["shift+a"],
    label: "Select every device on the page",
    scope: "fleet",
    operator: true,
  },
  "fleet.update": {
    keys: ["u"],
    label: "Update the selected devices",
    scope: "fleet",
    operator: true,
  },
  "fleet.clear": {
    keys: ["escape"],
    label: "Drop the cursor, then the selection",
    scope: "fleet",
  },

  "device.exec": {
    keys: ["e"],
    label: "Execute a command",
    scope: "device",
    operator: true,
    command: true,
  },
  "device.logs": {
    keys: ["l"],
    label: "Live logs",
    scope: "device",
    operator: true,
    command: true,
  },
  "device.screenshot": {
    keys: ["s"],
    label: "Screenshot",
    scope: "device",
    operator: true,
    command: true,
  },
  "device.logcat": {
    keys: ["shift+l"],
    label: "Download logcat (.zip)",
    scope: "device",
    operator: true,
    command: true,
  },
  "device.rename": { keys: ["r"], label: "Rename", scope: "device", operator: true, command: true },
  "device.maintenance": {
    keys: ["m"],
    label: "Maintenance",
    scope: "device",
    operator: true,
    command: true,
  },
  "device.reboot": {
    keys: ["shift+r"],
    label: "Reboot",
    scope: "device",
    operator: true,
    command: true,
  },
  "device.overview": { keys: ["1"], label: "Overview", scope: "device", command: true },
  "device.rotom": { keys: ["2"], label: "Scanner (Rotom)", scope: "device", command: true },
  "device.metrics": { keys: ["3"], label: "Load history", scope: "device", command: true },
  "device.connectivity": { keys: ["4"], label: "Connectivity", scope: "device", command: true },
} as const satisfies Record<string, ShortcutDef>;

export type ShortcutId = keyof typeof SHORTCUTS;

export function shortcutDef(id: ShortcutId): ShortcutDef {
  return SHORTCUTS[id];
}

/** The key a menu shows beside the item, when a shortcut has alternatives. */
export function primaryKey(id: ShortcutId): string {
  return SHORTCUTS[id].keys[0];
}

export const SHORTCUT_IDS = Object.keys(SHORTCUTS) as ShortcutId[];

/** The headings of the `?` dialog, in the order it shows them. */
export const SCOPES: { scope: ShortcutScope; label: string; note?: string }[] = [
  { scope: "global", label: "Everywhere" },
  { scope: "navigation", label: "Go to", note: "Press g, then the letter." },
  {
    scope: "fleet",
    label: "Fleet table",
    note: "↑ and ↓ move the cursor once a row has it; until then they scroll the page.",
  },
  {
    scope: "device",
    label: "Devices",
    note:
      "On a device's own pages. In the Fleet they act on the row under the cursor — " +
      "Rename and Reboot on the whole selection when there is one.",
  },
];

/** One step of a sequence, parsed: `shift+r` is `{ key: "r", shift: true }`. */
export type KeyStep = { key: string; mod: boolean; shift: boolean; alt: boolean };

export function parseCombo(combo: string): KeyStep[] {
  return combo.split(" ").map((step) => {
    // `+` would be ambiguous as a key and nothing binds it, so the last part is
    // always the key and everything before it a modifier.
    const parts = step.split("+");
    const key = parts.pop()!;
    return {
      key,
      mod: parts.includes("mod"),
      shift: parts.includes("shift"),
      alt: parts.includes("alt"),
    };
  });
}

/**
 * A letter is case-folded and has its shift checked; a symbol is compared as
 * typed with shift ignored, because shift is how half of them are typed at all.
 * Digits count as symbols — shift turns them into something else anyway.
 */
export function isLetterKey(key: string): boolean {
  return key.length === 1 && key.toLowerCase() !== key.toUpperCase();
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

const NAMED: Record<string, string> = {
  arrowdown: "↓",
  arrowup: "↑",
  arrowleft: "←",
  arrowright: "→",
  enter: "Enter",
  escape: "Esc",
  space: "Space",
};

/** The labels on the key caps for one step, e.g. `["Ctrl", "K"]` or `["⇧", "R"]`. */
export function keyCaps(step: KeyStep, mac: boolean): string[] {
  const caps: string[] = [];
  if (step.mod) caps.push(mac ? "⌘" : "Ctrl");
  if (step.alt) caps.push(mac ? "⌥" : "Alt");
  if (step.shift) caps.push(mac ? "⇧" : "Shift");
  caps.push(NAMED[step.key] ?? (step.key.length === 1 ? step.key.toUpperCase() : step.key));
  return caps;
}
