"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  LayoutGrid,
  Menu,
  Package,
  PanelLeft,
  Rocket,
  Server,
  Settings,
  Binoculars,
  Upload,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

type NavLink = { href: string; label: string; icon: typeof LayoutGrid };

/** Grouped the way the work is: look at the fleet, ship to it, then configure it. */
const SECTIONS: { label?: string; links: NavLink[] }[] = [
  {
    links: [
      { href: "/", label: "Fleet", icon: LayoutGrid },
      { href: "/hosts", label: "Machines", icon: Server },
    ],
  },
  {
    label: "Deployment",
    links: [
      { href: "/rollouts", label: "Rollouts", icon: Rocket },
      { href: "/versions", label: "Versions", icon: Package },
      { href: "/manual", label: "Manual deploy", icon: Upload },
    ],
  },
  {
    label: "System",
    links: [
      { href: "/monitoring", label: "Monitoring", icon: Binoculars },
      { href: "/status", label: "Status", icon: Activity },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

const COLLAPSED_KEY = "magnemite:sidebar-collapsed";

export function Nav({
  online,
  total,
  activeRollouts,
}: {
  online: number;
  total: number;
  activeRollouts: number;
}) {
  const pathname = usePathname();

  // A fleet with one box away is normal and must not sit there looking like an
  // alarm; a fleet with none is the thing worth colouring. Everything between
  // is just how many are up.
  const tone =
    total === 0 ? "muted" : online === total ? "success" : online === 0 ? "danger" : "primary";
  const dotTone = {
    muted: "bg-muted-foreground/40",
    success: "bg-success",
    danger: "bg-destructive",
    primary: "bg-primary",
  }[tone];

  // Collapsing is a desktop affordance; on phones the same sidebar slides in
  // over the page instead, so the two states are tracked separately.
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Read after mount: the server cannot know the stored preference, and
  // rendering the collapsed width first would mismatch on hydration.
  useEffect(() => {
    setCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === "1");
  }, []);

  // A tap on a link should leave the drawer behind, not on top of the page.
  useEffect(() => setDrawerOpen(false), [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawerOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  // The page behind the drawer must not scroll under a thumb aimed at the
  // menu. Restored on close rather than cleared, so a page that had its own
  // overflow set keeps it.
  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [drawerOpen]);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      window.localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
      return next;
    });
  }

  return (
    <TooltipProvider delayDuration={150}>
      {/* Phones get a bar of their own; the sidebar itself is off-canvas there. */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background px-3 lg:hidden">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open menu"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <Menu />
        </Button>
        <img src="/magnemite.png" alt="" className="h-6 w-6 shrink-0 rounded-md" />
        <span className="font-display text-sm font-semibold tracking-tight">Magnemite</span>
      </header>

      {drawerOpen ? (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => setDrawerOpen(false)}
          aria-hidden
        />
      ) : null}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex shrink-0 flex-col border-r border-border bg-subtle",
          // `h-screen` is 100vh, which on a phone is taller than what the
          // browser actually shows — the theme toggle at the bottom ended up
          // under the URL bar. `dvh` is the visible height.
          "h-[100dvh] w-[min(17rem,85vw)]",
          // `visibility` rides along with the transform for a reason: closed,
          // the drawer is only translated off-screen, and its links stay in
          // the tab order — a phone keyboard walks into a menu nobody can see.
          // `invisible` takes it out of the tree and out of focus, and
          // transitioning it means the slide-out still plays before it goes.
          // Not `aria-hidden`: that cannot be undone per breakpoint, and on a
          // desktop the sidebar is on screen with `drawerOpen` false.
          "transition-[width,transform,visibility] duration-200 ease-out",
          drawerOpen ? "translate-x-0 visible" : "invisible -translate-x-full",
          "lg:visible lg:sticky lg:top-0 lg:h-screen lg:translate-x-0",
          collapsed ? "lg:w-[68px]" : "lg:w-60",
        )}
      >
        <div
          className={cn(
            "group/brand relative flex h-14 items-center px-3 lg:h-auto lg:py-4",
            collapsed ? "gap-2.5 lg:justify-center lg:px-0" : "gap-2.5",
          )}
        >
          <img
            src="/magnemite.png"
            alt=""
            className={cn(
              "h-7 w-7 shrink-0 rounded-lg transition-opacity",
              // Collapsed, the mark steps aside on hover so the toggle can use
              // the one row the rail has.
              collapsed && "lg:group-hover/brand:opacity-0",
            )}
          />

          <span
            className={cn(
              "font-display text-[15px] font-semibold tracking-tight",
              collapsed && "lg:hidden",
            )}
          >
            Magnemite
          </span>

          <Button
            variant="ghost"
            size="icon"
            aria-label="Close menu"
            className="ml-auto lg:hidden"
            onClick={() => setDrawerOpen(false)}
          >
            <X />
          </Button>

          <Tooltip label={collapsed ? "Expand menu" : "Close menu"}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={collapsed ? "Expand menu" : "Close menu"}
              onClick={toggleCollapsed}
              className={cn(
                "hidden lg:inline-flex",
                collapsed
                  ? "lg:absolute lg:inset-0 lg:m-auto lg:opacity-0 lg:group-hover/brand:opacity-100 lg:focus-visible:opacity-100"
                  : "ml-auto",
              )}
            >
              <PanelLeft />
            </Button>
          </Tooltip>
        </div>

        <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-2 py-2">
          {SECTIONS.map((section, i) => (
            <div key={section.label ?? i} className="flex flex-col gap-0.5">
              {section.label ? (
                <>
                  <div
                    className={cn(
                      "px-3 pb-1.5 text-xs font-medium text-muted-foreground",
                      collapsed && "lg:hidden",
                    )}
                  >
                    {section.label}
                  </div>
                  {/* With the labels gone, a rule is what keeps the groups apart. */}
                  <div
                    className={cn("mx-2 mb-1.5 hidden h-px bg-border", collapsed && "lg:block")}
                  />
                </>
              ) : null}

              {section.links.map(({ href, label, icon: Icon }) => {
                const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
                return (
                  <Tooltip key={href} label={label} disabled={!collapsed}>
                    <Link
                      href={href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium leading-5",
                        "transition-colors",
                        // Collapsed, the row becomes a 36px square — the same
                        // footprint as the icon button above it, so the active
                        // highlight reads as one shape with the rail rather
                        // than a wider slab.
                        collapsed && "lg:mx-auto lg:h-9 lg:w-9 lg:justify-center lg:p-0",
                        active
                          ? "bg-primary/15 text-foreground"
                          : "text-muted-foreground hover:bg-emphasis/60 hover:text-foreground",
                      )}
                    >
                      <Icon
                        className={cn(
                          "h-4 w-4 shrink-0 -translate-y-[0.5px] transition-colors",
                          // A 16px icon overhangs a 14px label: its box runs ~3px
                          // past the baseline while the label's ink stops there, so
                          // geometric centring reads low. Half a pixel up lands it
                          // on the label's cap band.
                          // Collapsed there is no label to align to.
                          collapsed && "lg:translate-y-0",
                          active
                            ? "text-primary"
                            : "text-muted-foreground group-hover:text-foreground",
                        )}
                      />
                      <span className={cn(collapsed && "lg:hidden")}>{label}</span>
                      {href === "/rollouts" && activeRollouts > 0 ? (
                        <Badge
                          className={cn(
                            // A rounded square rather than the Badge's pill:
                            // `min-w-6` so a single digit is not a narrow sliver
                            // next to a two-digit count, and the rail does not
                            // reflow when a rollout finishes.
                            "ml-auto min-w-6 rounded-md bg-primary px-1.5 text-primary-foreground tabular-nums",
                            collapsed && "lg:hidden",
                          )}
                        >
                          {activeRollouts}
                        </Badge>
                      ) : null}
                    </Link>
                  </Tooltip>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="flex flex-col gap-3 border-t border-border p-3">
          <Tooltip label={`${online} of ${total} devices online`} disabled={!collapsed}>
            {/* `12/40` in a monospace font was a fraction, and read like one —
                a ratio to work out rather than a fleet to glance at. A dot for
                the state, the two numbers in words, and a bar for the share
                answers it without arithmetic, and the bar is the only part
                that survives the rail collapsing. */}
            <div className={cn("flex flex-col gap-2 px-1", collapsed && "lg:px-0")}>
              <div
                className={cn(
                  "flex items-center justify-between gap-2 text-xs",
                  collapsed && "lg:justify-center",
                )}
              >
                <span className={cn("text-muted-foreground", collapsed && "lg:hidden")}>
                  Devices online
                </span>
                <span className="flex items-center gap-1.5 tabular-nums">
                  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotTone)} />
                  <span className="font-medium">{online}</span>
                  <span className={cn("text-muted-foreground", collapsed && "lg:hidden")}>
                    of {total}
                  </span>
                </span>
              </div>
              <Progress
                value={total > 0 ? (online / total) * 100 : 0}
                tone={tone}
                className="h-1"
              />
            </div>
          </Tooltip>

          <ThemeToggle compact={collapsed} />
        </div>
      </aside>
    </TooltipProvider>
  );
}
