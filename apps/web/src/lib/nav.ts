import {
  Activity,
  Binoculars,
  LayoutGrid,
  Package,
  Rocket,
  Server,
  Settings,
  Upload,
  type LucideIcon,
} from "lucide-react";
import type { ShortcutId } from "@/lib/shortcuts";

export type NavLink = { href: string; label: string; icon: LucideIcon; shortcut: ShortcutId };

/**
 * Grouped the way the work is: look at the fleet, ship to it, then configure it.
 *
 * Shared by the sidebar, the command palette and the `g` shortcuts, so a page
 * added here is reachable all three ways at once.
 */
export const NAV_SECTIONS: { label?: string; links: NavLink[] }[] = [
  {
    links: [
      { href: "/", label: "Fleet", icon: LayoutGrid, shortcut: "nav.fleet" },
      { href: "/hosts", label: "Machines", icon: Server, shortcut: "nav.hosts" },
    ],
  },
  {
    label: "Deployment",
    links: [
      { href: "/rollouts", label: "Rollouts", icon: Rocket, shortcut: "nav.rollouts" },
      { href: "/versions", label: "Versions", icon: Package, shortcut: "nav.versions" },
      { href: "/manual", label: "Manual deploy", icon: Upload, shortcut: "nav.manual" },
    ],
  },
  {
    label: "System",
    links: [
      { href: "/monitoring", label: "Monitoring", icon: Binoculars, shortcut: "nav.monitoring" },
      { href: "/status", label: "Status", icon: Activity, shortcut: "nav.status" },
      { href: "/settings", label: "Settings", icon: Settings, shortcut: "nav.settings" },
    ],
  },
];

export const NAV_LINKS: NavLink[] = NAV_SECTIONS.flatMap((section) => section.links);

/** Whether a link is the page being looked at, or a page under it. */
export function isActiveLink(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}
