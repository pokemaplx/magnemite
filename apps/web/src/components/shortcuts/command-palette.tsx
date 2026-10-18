"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "@bprogress/next/app";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { Command } from "cmdk";
import {
  Activity,
  ArrowLeft,
  Camera,
  Check,
  ChevronRight,
  History,
  Keyboard,
  LayoutDashboard,
  Monitor,
  Moon,
  PanelLeft,
  Pencil,
  Power,
  Radio,
  RadioTower,
  ScrollText,
  Search,
  Server,
  Sun,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { OnlineDot } from "@/components/status";
import { matchCategories, type SettingsSectionId } from "@/components/settings/categories";
import { useShortcuts, useShortcutsState } from "@/components/shortcuts/hotkeys";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { commandBlocker, type DeviceCommand } from "@/lib/device-commands";
import { NAV_LINKS } from "@/lib/nav";
import type { PaletteBox, PaletteData } from "@/lib/palette";
import { primaryKey, shortcutDef, type ShortcutId } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

/** How many boxes a search lists. Past this the search wants another letter. */
const MAX_BOXES = 50;
const MAX_HOSTS = 20;
/** "box-12 rotom" — how many boxes a jump straight to a page is offered for. */
const MAX_JUMP_BOXES = 5;

type DevicePageEntry = {
  suffix: string;
  shortcut: ShortcutId;
  icon: LucideIcon;
  keywords: string[];
  needsRotom?: boolean;
};

/** A box's own pages, in the order its `1`–`4` keys go. */
const DEVICE_PAGES: DevicePageEntry[] = [
  {
    suffix: "",
    shortcut: "device.overview",
    icon: LayoutDashboard,
    keywords: ["overview", "device", "details", "packages", "history"],
  },
  {
    suffix: "/rotom",
    shortcut: "device.rotom",
    icon: RadioTower,
    keywords: ["rotom", "scanner", "workers"],
    needsRotom: true,
  },
  {
    suffix: "/metrics",
    shortcut: "device.metrics",
    icon: Activity,
    keywords: ["metrics", "load", "cpu", "memory", "storage"],
  },
  {
    suffix: "/connectivity",
    shortcut: "device.connectivity",
    icon: History,
    keywords: ["connectivity", "uptime", "offline", "reboots", "episodes"],
  },
];

type DeviceActionEntry = {
  command: DeviceCommand;
  shortcut: ShortcutId;
  icon: LucideIcon;
  keywords: string[];
};

const DEVICE_ACTIONS: DeviceActionEntry[] = [
  { command: "exec", shortcut: "device.exec", icon: Terminal, keywords: ["shell", "run", "adb"] },
  { command: "logs", shortcut: "device.logs", icon: Radio, keywords: ["logcat", "tail", "follow"] },
  {
    command: "screenshot",
    shortcut: "device.screenshot",
    icon: Camera,
    keywords: ["screen", "picture", "capture"],
  },
  {
    command: "logcat",
    shortcut: "device.logcat",
    icon: ScrollText,
    keywords: ["logs", "zip", "download", "bundle"],
  },
  { command: "rename", shortcut: "device.rename", icon: Pencil, keywords: ["name"] },
  {
    command: "maintenance",
    shortcut: "device.maintenance",
    icon: Wrench,
    keywords: ["park", "pause", "work"],
  },
  { command: "reboot", shortcut: "device.reboot", icon: Power, keywords: ["restart"] },
];

/** Icons for the "On this page" commands, which are shortcuts the page has bound. */
const COMMAND_ICONS: Partial<Record<ShortcutId, LucideIcon>> = {
  search: Search,
  ...Object.fromEntries(DEVICE_ACTIONS.map((entry) => [entry.shortcut, entry.icon])),
  ...Object.fromEntries(DEVICE_PAGES.map((entry) => [entry.shortcut, entry.icon])),
};

type Page = { kind: "root" } | { kind: "device"; id: string };

function wordsOf(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function hasEvery(haystack: string, words: string[]): boolean {
  const lower = haystack.toLowerCase();
  return words.every((word) => lower.includes(word));
}

/** A page or action named by the last word typed — "rot" for the scanner page. */
function namedBy(word: string, label: string, keywords: string[]): boolean {
  return [...label.toLowerCase().split(/[^a-z0-9]+/), ...keywords].some((part) =>
    part.startsWith(word),
  );
}

/**
 * Every word has to be somewhere in the box — name, serial, model or group —
 * and a name that starts with what was typed comes before one that merely
 * contains it. Numeric order, so box-2 sits before box-10.
 */
function rankBoxes(boxes: PaletteBox[], words: string[], limit: number): PaletteBox[] {
  if (words.length === 0) return [];
  const query = words.join(" ");
  const scored: { box: PaletteBox; score: number }[] = [];
  for (const box of boxes) {
    const haystack = `${box.name} ${box.serial} ${box.model ?? ""} ${box.groupName ?? ""}`;
    if (!hasEvery(haystack, words)) continue;
    const name = box.name.toLowerCase();
    const score = name === query ? 0 : name.startsWith(query) ? 1 : name.includes(query) ? 2 : 3;
    scored.push({ box, score });
  }
  scored.sort(
    (a, b) =>
      a.score - b.score || a.box.name.localeCompare(b.box.name, undefined, { numeric: true }),
  );
  return scored.slice(0, limit).map((entry) => entry.box);
}

/**
 * Ctrl/⌘K: anywhere in the dashboard, by name.
 *
 * The boxes are what it is mostly for. Picking one opens its own short list —
 * its pages and what can be done to it — so "the scanner page of box-12" is
 * box-12, Enter, scanner, Enter; and typing "box-12 rotom" goes straight there.
 *
 * Filtering is done here rather than by cmdk: its fuzzy match ranks
 * box-1…box-300 as near enough identical, and a fleet's worth of rows rendered
 * at once is the slow part of a palette. So the list is only ever the best
 * fifty, ranked by a rule somebody can predict.
 */
export function CommandPalette() {
  const router = useRouter();
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const { canOperate, run, isBound, commands, setPaletteOpen, setHelpOpen, setSingleKeys } =
    useShortcuts();
  const { paletteOpen, singleKeys } = useShortcutsState();

  const [data, setData] = useState<PaletteData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [page, setPage] = useState<Page>({ kind: "root" });
  const [search, setSearch] = useState("");
  // What was typed before stepping into a box, so stepping back out lands on
  // the same list with the same box highlighted.
  const [rootSearch, setRootSearch] = useState("");
  const [value, setValue] = useState("");

  // Run after the palette has closed and handed focus back: an action that
  // opens a dialog of its own would otherwise lose its focus to the palette's
  // closing, and `/` would focus a field only to have it taken away.
  const pending = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!paletteOpen) return;
    const controller = new AbortController();
    setLoadError(null);
    fetch("/api/palette", { signal: controller.signal, cache: "no-store" })
      .then(async (res) => {
        if (res.status === 401) throw new Error("Signed out — reload the page to sign in.");
        if (!res.ok) throw new Error(`The server answered ${res.status}.`);
        return (await res.json()) as PaletteData;
      })
      .then(setData)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, [paletteOpen]);

  // Back to the top for the next time, once nobody can see it happen.
  useEffect(() => {
    if (paletteOpen) return;
    setPage({ kind: "root" });
    setSearch("");
    setRootSearch("");
    setValue("");
  }, [paletteOpen]);

  function go(next: () => void) {
    pending.current = next;
    setPaletteOpen(false);
  }

  function enterBox(id: string) {
    setRootSearch(search);
    setSearch("");
    setValue("");
    setPage({ kind: "device", id });
  }

  function back() {
    const from = page.kind === "device" ? page.id : null;
    setPage({ kind: "root" });
    setSearch(rootSearch);
    setValue(from ? `device:${from}` : "");
  }

  function openSettings(id: SettingsSectionId) {
    // Next moves between hashes of the page it is already on without the
    // `hashchange` Settings listens for, so on Settings it is changed in place
    // and announced — replaced, the way the page's own rail does it, so the
    // back button leaves Settings rather than walking its tabs.
    if (pathname === "/settings") {
      window.history.replaceState(null, "", `#${id}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    } else {
      router.push(`/settings#${id}`);
    }
  }

  /**
   * A box's action from the palette. On that box's own page the page has the
   * action bound already, so it simply runs; from anywhere else the page is
   * opened with `?action=`, which it reads once and drops.
   */
  function runOnBox(box: PaletteBox, entry: DeviceActionEntry) {
    if (pathname === `/devices/${box.id}` && isBound(entry.shortcut)) {
      run(entry.shortcut);
      return;
    }
    router.push(`/devices/${box.id}?action=${entry.command}`);
  }

  const words = wordsOf(search);
  const boxes = data?.boxes ?? [];
  const box = page.kind === "device" ? boxes.find((b) => b.id === page.id) : undefined;

  // The box was removed while its list was open, or the data is a reload
  // behind: back to the top rather than a list for nothing.
  useEffect(() => {
    if (page.kind === "device" && data && !data.boxes.some((b) => b.id === page.id)) {
      setPage({ kind: "root" });
    }
  }, [page, data]);

  const pages = (target: PaletteBox) =>
    DEVICE_PAGES.filter((entry) => !entry.needsRotom || target.hasRotom);
  const actions = (target: PaletteBox) =>
    canOperate
      ? DEVICE_ACTIONS.filter((entry) => entry.command !== "screenshot" || target.canScreenshot)
      : [];

  // A key is only shown where pressing it would do the same thing: the page
  // keys on any of the box's own pages, the action keys on its overview. In
  // the Fleet, `e` means the row under the cursor — not the box in this list.
  const onBoxPages = (target: PaletteBox) => pathname.startsWith(`/devices/${target.id}`);
  const onBoxOverview = (target: PaletteBox) => pathname === `/devices/${target.id}`;

  function pageItem(target: PaletteBox, entry: DevicePageEntry, prefix: string): ReactNode {
    return (
      <Item
        key={`${prefix}${target.id}:${entry.shortcut}`}
        value={`${prefix}${target.id}:${entry.shortcut}`}
        icon={<entry.icon />}
        onSelect={() => go(() => router.push(`/devices/${target.id}${entry.suffix}`))}
        keys={!prefix && onBoxPages(target) ? primaryKey(entry.shortcut) : undefined}
      >
        {prefix ? <BoxCrumb name={target.name} /> : null}
        {shortcutDef(entry.shortcut).label}
      </Item>
    );
  }

  function actionItem(target: PaletteBox, entry: DeviceActionEntry, prefix: string): ReactNode {
    const blocker = commandBlocker(target, entry.command);
    return (
      <Item
        key={`${prefix}${target.id}:${entry.shortcut}`}
        value={`${prefix}${target.id}:${entry.shortcut}`}
        icon={<entry.icon />}
        disabled={blocker !== null}
        hint={blocker ? (target.online ? "unavailable" : "offline") : undefined}
        onSelect={() => go(() => runOnBox(target, entry))}
        keys={!prefix && onBoxOverview(target) ? primaryKey(entry.shortcut) : undefined}
      >
        {prefix ? <BoxCrumb name={target.name} /> : null}
        {shortcutDef(entry.shortcut).label}
      </Item>
    );
  }

  let body: ReactNode;

  if (page.kind === "device" && box) {
    const shownPages = pages(box).filter((entry) =>
      hasEvery(`${shortcutDef(entry.shortcut).label} ${entry.keywords.join(" ")}`, words),
    );
    const shownActions = actions(box).filter((entry) =>
      hasEvery(`${shortcutDef(entry.shortcut).label} ${entry.keywords.join(" ")}`, words),
    );
    body = (
      <>
        {shownPages.length > 0 ? (
          <Command.Group heading="Open">
            {shownPages.map((entry) => pageItem(box, entry, ""))}
          </Command.Group>
        ) : null}
        {shownActions.length > 0 ? (
          <Command.Group heading="Actions">
            {shownActions.map((entry) => actionItem(box, entry, ""))}
          </Command.Group>
        ) : null}
      </>
    );
  } else {
    const searching = words.length > 0;

    // "box-12 rotom": everything but the last word finds the box, the last
    // word names one of its pages or actions.
    const tail = words[words.length - 1] ?? "";
    const head = words.slice(0, -1);
    const jumps: ReactNode[] = [];
    if (head.length > 0) {
      for (const target of rankBoxes(boxes, head, MAX_JUMP_BOXES)) {
        for (const entry of pages(target)) {
          if (namedBy(tail, shortcutDef(entry.shortcut).label, entry.keywords)) {
            jumps.push(pageItem(target, entry, "jump:"));
          }
        }
        for (const entry of actions(target)) {
          if (namedBy(tail, shortcutDef(entry.shortcut).label, entry.keywords)) {
            jumps.push(actionItem(target, entry, "jump:"));
          }
        }
      }
    }

    const foundBoxes = rankBoxes(boxes, words, MAX_BOXES);
    const foundHosts = searching
      ? (data?.hosts ?? []).filter((host) => hasEvery(host.name, words)).slice(0, MAX_HOSTS)
      : [];
    const links = NAV_LINKS.filter((link) => hasEvery(link.label, words));
    const sections = searching ? matchCategories(search) : [];
    const here = (paletteOpen ? commands() : []).filter((id) =>
      hasEvery(shortcutDef(id).label, words),
    );

    const preferences: {
      value: string;
      label: string;
      icon: LucideIcon;
      keys?: string;
      on?: boolean;
      run: () => void;
    }[] = [
      {
        value: "pref:shortcuts",
        label: "Keyboard shortcuts",
        icon: Keyboard,
        keys: primaryKey("help"),
        run: () => setHelpOpen(true),
      },
      ...(isBound("sidebar")
        ? [
            {
              value: "pref:sidebar",
              label: shortcutDef("sidebar").label,
              icon: PanelLeft,
              keys: primaryKey("sidebar"),
              run: () => run("sidebar"),
            },
          ]
        : []),
      {
        value: "pref:theme-light",
        label: "Light theme",
        icon: Sun,
        on: theme === "light",
        run: () => setTheme("light"),
      },
      {
        value: "pref:theme-dark",
        label: "Dark theme",
        icon: Moon,
        on: theme === "dark",
        run: () => setTheme("dark"),
      },
      {
        value: "pref:theme-system",
        label: "System theme",
        icon: Monitor,
        on: theme === "system",
        run: () => setTheme("system"),
      },
      {
        value: "pref:single-keys",
        label: singleKeys ? "Turn off single-key shortcuts" : "Turn on single-key shortcuts",
        icon: Keyboard,
        run: () => setSingleKeys(!singleKeys),
      },
    ].filter((pref) => hasEvery(`${pref.label} preferences settings`, words));

    body = (
      <>
        {jumps.length > 0 ? <Command.Group heading="Jump to">{jumps}</Command.Group> : null}

        {searching && boxes.length > 0 && foundBoxes.length > 0 ? (
          <Command.Group heading="Devices">
            {foundBoxes.map((target) => (
              <Item
                key={target.id}
                value={`device:${target.id}`}
                icon={<OnlineDot online={target.online} />}
                onSelect={() => enterBox(target.id)}
                hint={target.groupName ?? undefined}
                trailing={<ChevronRight className="h-4 w-4 text-muted-foreground" />}
              >
                <span className="truncate">{target.name}</span>
                <span className="ml-2 truncate font-mono text-xs text-muted-foreground">
                  {target.model ?? target.serial}
                </span>
                {target.approved ? null : (
                  <span className="ml-2 text-xs text-warning">pending approval</span>
                )}
              </Item>
            ))}
          </Command.Group>
        ) : null}

        {searching && !data ? (
          <Command.Loading>
            <p className="px-2 py-3 text-sm text-muted-foreground">
              {loadError ? `Could not load the devices: ${loadError}` : "Loading devices…"}
            </p>
          </Command.Loading>
        ) : null}

        {foundHosts.length > 0 ? (
          <Command.Group heading="Machines">
            {foundHosts.map((host) => (
              <Item
                key={host.id}
                value={`host:${host.id}`}
                icon={<Server />}
                hint={host.online ? undefined : "offline"}
                onSelect={() => go(() => router.push(`/hosts/${host.id}`))}
              >
                {host.name}
              </Item>
            ))}
          </Command.Group>
        ) : null}

        {here.length > 0 ? (
          <Command.Group heading="On this page">
            {here.map((id) => {
              const Icon = COMMAND_ICONS[id] ?? Keyboard;
              return (
                <Item
                  key={id}
                  value={`cmd:${id}`}
                  icon={<Icon />}
                  keys={primaryKey(id)}
                  onSelect={() => go(() => run(id))}
                >
                  {shortcutDef(id).label}
                </Item>
              );
            })}
          </Command.Group>
        ) : null}

        {links.length > 0 ? (
          <Command.Group heading="Go to">
            {links.map((link) => (
              <Item
                key={link.href}
                value={`nav:${link.href}`}
                icon={<link.icon />}
                keys={primaryKey(link.shortcut)}
                onSelect={() => go(() => router.push(link.href))}
              >
                {link.label}
              </Item>
            ))}
          </Command.Group>
        ) : null}

        {sections.length > 0 ? (
          <Command.Group heading="Settings">
            {sections.map(({ category, hits }) => (
              <Item
                key={category.id}
                value={`settings:${category.id}`}
                icon={<category.icon />}
                hint={hits.slice(0, 2).join(" · ") || undefined}
                onSelect={() => go(() => openSettings(category.id))}
              >
                {category.label}
              </Item>
            ))}
          </Command.Group>
        ) : null}

        {preferences.length > 0 ? (
          <Command.Group heading="Preferences">
            {preferences.map((pref) => (
              <Item
                key={pref.value}
                value={pref.value}
                icon={<pref.icon />}
                keys={pref.keys}
                trailing={pref.on ? <Check className="h-4 w-4 text-primary" /> : undefined}
                onSelect={() => go(pref.run)}
              >
                {pref.label}
              </Item>
            ))}
          </Command.Group>
        ) : null}
      </>
    );
  }

  return (
    <Dialog open={paletteOpen} onOpenChange={setPaletteOpen}>
      <DialogContent
        data-palette=""
        showClose={false}
        aria-describedby={undefined}
        className="top-[12vh] max-w-xl translate-y-0 overflow-hidden p-0"
        onEscapeKeyDown={(event) => {
          // Escape inside a box's list steps back out, the way Backspace does.
          if (page.kind === "device") {
            event.preventDefault();
            back();
          }
        }}
        onCloseAutoFocus={(event) => {
          const next = pending.current;
          if (!next) return;
          pending.current = null;
          event.preventDefault();
          next();
        }}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command
          label="Command palette"
          shouldFilter={false}
          loop
          // Its Ctrl+J/K/N/P list keys would swallow the Ctrl+K that closes
          // the palette again.
          vimBindings={false}
          value={value}
          onValueChange={setValue}
          onKeyDown={(event) => {
            if (event.key === "Backspace" && search === "" && page.kind === "device") {
              event.preventDefault();
              back();
            }
          }}
          className={cn(
            "flex flex-col",
            "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2",
            "[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground",
          )}
        >
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            {page.kind === "device" && box ? (
              <button
                type="button"
                tabIndex={-1}
                onClick={back}
                className="flex shrink-0 items-center gap-1.5 rounded-md bg-subtle px-2 py-1 text-xs font-medium transition-colors hover:bg-emphasis"
              >
                <ArrowLeft className="h-3 w-3" />
                <OnlineDot online={box.online} />
                {box.name}
              </button>
            ) : null}
            <Command.Input
              value={search}
              onValueChange={setSearch}
              placeholder={
                page.kind === "device" ? "Pages and actions…" : "Search devices, pages, actions…"
              }
              className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          <Command.List className="max-h-[min(60vh,26rem)] overflow-y-auto overscroll-contain p-2">
            {/* Not while the devices are still on their way: "nothing matches"
                would be a guess, and the loading row below says what is true. */}
            {data !== null ? (
              <Command.Empty className="px-2 py-8 text-center text-sm text-muted-foreground">
                Nothing matches.
              </Command.Empty>
            ) : null}
            {body}
          </Command.List>

          <div className="flex items-center gap-4 border-t border-border px-3 py-2 text-xs text-muted-foreground max-sm:hidden">
            <span className="flex items-center gap-1.5">
              <Kbd keys="arrowup" />
              <Kbd keys="arrowdown" />
              to move
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd keys="enter" />
              to open
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd keys="escape" />
              {page.kind === "device" ? "to go back" : "to close"}
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function BoxCrumb({ name }: { name: string }) {
  return (
    <span className="text-muted-foreground">
      {name}
      <ChevronRight className="mx-1 inline h-3 w-3 -translate-y-px" />
    </span>
  );
}

function Item({
  value,
  icon,
  children,
  hint,
  keys,
  trailing,
  disabled,
  onSelect,
}: {
  value: string;
  icon: ReactNode;
  children: ReactNode;
  /** Muted text at the right — a group, a reason it is greyed out. */
  hint?: string;
  /** The key that does the same thing, shown as key caps. */
  keys?: string;
  trailing?: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <Command.Item
      value={value}
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer select-none items-center gap-3 rounded-md px-2 py-2 text-sm",
        "data-[selected=true]:bg-subtle data-[disabled=true]:cursor-default data-[disabled=true]:opacity-40",
      )}
    >
      <span className="flex w-4 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-4">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 items-center">{children}</span>
      {hint ? (
        <span className="shrink-0 truncate text-xs text-muted-foreground">{hint}</span>
      ) : null}
      {keys ? <Kbd keys={keys} className="shrink-0 max-sm:hidden" /> : null}
      {trailing}
    </Command.Item>
  );
}
