import {
  AppWindow,
  Bell,
  Binoculars,
  Boxes,
  KeyRound,
  Rss,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";

export type SettingsSectionId =
  "tuning" | "monitoring" | "notifications" | "apps" | "sources" | "groups" | "enrollment";

export type SettingsCategory = {
  id: SettingsSectionId;
  label: string;
  icon: LucideIcon;
  summary: string;
  /**
   * The words a person would actually type looking for a knob in this
   * category — field labels, and the names things go by elsewhere. Searching
   * "cooldown" has to land on Hub without them having to know it lives there.
   */
  terms: string[];
};

/**
 * Ordered the way the fleet is set up: the numbers first, then what it ships,
 * then who joins.
 *
 * The first category is called Tuning rather than Hub because that is what it
 * is: everything changed while the thing runs, as opposed to `.env`, which is
 * what it needs to boot. It stopped being about the hub in particular the
 * moment the monitoring ceilings moved onto it.
 *
 * Its own module so the command palette can offer the same categories, found
 * by the same words, without importing the whole Settings page.
 */
export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    id: "tuning",
    label: "Tuning",
    icon: SlidersHorizontal,
    summary: "Fleet-wide limits, polling, and the ceilings monitoring acts inside.",
    terms: [
      "max concurrent jobs",
      "job stall timeout",
      "metric history",
      "sample interval",
      "history retention",
      "metrics",
      // The same two fields govern the scanner charts, so the words for those
      // have to land here rather than on the Rotom page they are drawn on.
      "rotom history",
      "scanner history",
      "heartbeat",
      "offline timeout",
      // The monitoring knobs live on this tab now, so the words somebody
      // would search for have to point here rather than at the rules. Where
      // alerts go does not: that is the Notifications tab's.
      "actions per hour",
      "reboots per day",
      "reboot grace",
      "hub restart grace",
      "rotom sync interval",
      "rotom stale",
      // The rewrite that follows a worker count change is set here, while the
      // count itself is on the Redroid card -- so both words lead to Tuning.
      "config rewrites",
      "workers config",
    ],
  },
  {
    id: "monitoring",
    label: "Monitoring",
    icon: Binoculars,
    summary: "What counts as a box gone wrong, and what to do about it.",
    terms: [
      "automations",
      "rules",
      "escalation",
      "restart the scanner",
      "reboot the box",
      "pogo not in focus",
      "anr",
      "health check",
      "loop stalled",
      "unreachable",
      "rotom disconnected",
      "rotom not scanning",
      "rotom idle",
      "no workers",
      "reboot through rotom",
      "threshold",
      "cooldown",
      "quiet hours",
      "probe",
    ],
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: Bell,
    summary: "Discord, ntfy and web push, and which fleet events go to each.",
    // The channels' own field names, then the events by the words an
    // operator would use for them — "rollout finished", not the event id.
    terms: [
      "discord webhook",
      "role to ping",
      "ntfy",
      "topic",
      "access token",
      "web push",
      "vapid",
      "this browser",
      "test alert",
      "alerts",
      "repeat an alert",
      "dedupe",
      "rollout started",
      "rollout finished",
      "auto-update started",
      "manual deploy",
      "canary failed",
      "new build",
      "download failed",
      "source failing",
      "machine setup",
      "containers failed",
      "agent update failed",
    ],
  },
  {
    id: "apps",
    label: "Apps",
    icon: AppWindow,
    summary: "The packages this fleet installs, and how their rollouts start on their own.",
    terms: [
      "app target",
      "auto-update",
      "automatic rollouts",
      "approve versions",
      "canary devices",
      "soak minutes",
      "retry backoff",
      "attempts per device",
      "auto-update cooldown",
      "rollout window",
      "package name",
    ],
  },
  {
    id: "sources",
    label: "Version sources",
    icon: Rss,
    summary: "The indexes new builds are discovered at, and which one wins a tie.",
    terms: [
      "index url",
      "base url",
      "priority",
      "source poll interval",
      "poll",
      "mirror",
      "feed",
      "discovery",
    ],
  },
  {
    id: "groups",
    label: "Device groups",
    icon: Boxes,
    summary:
      "Install hooks, per-site concurrency, and the MITM each site runs — its version column and its config file.",
    // The Fleet columns tab's words are in here rather than gone: the column is
    // still a thing, it is just declared on the group that runs the app now,
    // and somebody searching for what they used to call it has to land here.
    terms: [
      "pre-install hook",
      "post-install hook",
      "concurrent updates",
      "site",
      "force-stop",
      "root",
      "mitm",
      "aegis",
      "atlas",
      "gocheats",
      "scanner",
      "config json",
      "config path",
      "restart command",
      "placeholder",
      "rotom origin",
      "push config",
      "fleet column",
      "watched package",
      "column header",
      "reporting",
      "installed version",
    ],
  },
  {
    id: "enrollment",
    label: "Enrollment",
    icon: KeyRound,
    summary: "The tokens a new box presents once to join the fleet.",
    terms: ["token", "auto-approve devices", "max uses", "revoke", "config.json", "magisk"],
  },
];

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return SETTINGS_CATEGORIES.some((category) => category.id === value);
}

/**
 * Categories whose label, summary or field names contain every word typed,
 * along with the field names that matched.
 *
 * Every word rather than any: "poll minutes" should narrow to Hub, not widen
 * to everything mentioning either.
 */
export function matchCategories(query: string): { category: SettingsCategory; hits: string[] }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return SETTINGS_CATEGORIES.map((category) => ({ category, hits: [] }));

  const result: { category: SettingsCategory; hits: string[] }[] = [];
  for (const category of SETTINGS_CATEGORIES) {
    const haystack =
      `${category.label} ${category.summary} ${category.terms.join(" ")}`.toLowerCase();
    if (!words.every((word) => haystack.includes(word))) continue;
    result.push({
      category,
      hits: category.terms.filter((term) => words.some((word) => term.includes(word))),
    });
  }
  return result;
}
