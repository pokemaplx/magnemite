"use client";

import { useMemo, useState, useTransition, type ReactNode } from "react";
import { Bell, BellOff, Binoculars, Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
import type { MonitorChannel } from "@magnemite/db";
import { deleteMonitorRule, setMonitorEnabled, setMonitorRuleEnabled } from "@/actions/monitoring";
import type { ActionState } from "@/actions/rollouts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Label } from "@/components/ui/label";
import { SearchInput } from "@/components/ui/search-input";
import { Switch } from "@/components/ui/switch";
import {
  MonitorRuleDialog,
  type GroupChoice,
  type MonitorRuleRow,
} from "@/components/settings/monitor-rule-dialog";
import { actionMeta, CHANNEL_IDS, CHANNEL_LABELS, signalMeta } from "@/lib/monitor-vocabulary";
import { cn } from "@/lib/utils";

export type {
  GroupChoice,
  MonitorRuleRow,
  MonitorStepRow,
} from "@/components/settings/monitor-rule-dialog";

export type MonitorSettingsRow = {
  enabled: boolean;
  rotomSyncSeconds: number;
  rotomStaleSeconds: number;
  rebootGraceSeconds: number;
  startupGraceSeconds: number;
  maxActionsPerDeviceHour: number;
  maxRebootsPerDeviceDay: number;
  alertDedupeMinutes: number;
  eventRetentionDays: number;
  discordWebhookUrl: string;
  discordMentionRoleId: string;
  ntfyUrl: string;
  ntfyTopic: string;
  ntfyToken: string;
  webPushEnabled: boolean;
};

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

/**
 * The switch and the rules.
 *
 * Two things this tab deliberately does *not* hold. The record of what the
 * rules did lives on the Monitoring page in the main nav, because it answers
 * an operational question rather than a configuration one, and a feed that
 * grows all day does not belong in Settings. The ceilings, graces and
 * intervals live on the Hub tab, because every one of them is measured
 * against a number that was already there.
 */
export function MonitoringSection({
  settings,
  rules,
  groups,
  deviceCount,
  capableCount,
  disabled,
}: {
  settings: MonitorSettingsRow;
  rules: MonitorRuleRow[];
  groups: GroupChoice[];
  deviceCount: number;
  /** Boxes on an agent new enough to run the probes. */
  capableCount: number;
  disabled: boolean;
}) {
  return (
    <>
      {/* The master switch first, on its own: it is the one control here that
          decides whether any of the rest happens, and reading a page of rules
          without knowing that answer is reading it twice. Then the rules,
          which are the whole of this tab now — the ceilings and graces around
          them moved to Settings → Tuning, next to the heartbeat and the offline
          timeout they are measured against. */}
      <MasterSwitch enabled={settings.enabled} disabled={disabled} />
      <RulesCard
        rules={rules}
        groups={groups}
        enabled={settings.enabled}
        deviceCount={deviceCount}
        capableCount={capableCount}
        disabled={disabled}
      />
    </>
  );
}

/**
 * Is any of this running.
 *
 * Saves on the flick rather than through a Save button, for the same reason
 * the switch on a rule row does: it is one boolean, the answer is visible in
 * the control itself, and a switch that needs confirming somewhere else is a
 * switch people leave in the wrong position. Optimistic, and it springs back
 * with the reason if the server disagrees.
 */
function MasterSwitch({ enabled, disabled }: { enabled: boolean; disabled: boolean }) {
  const [on, setOn] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle(next: boolean) {
    setOn(next);
    setError(null);
    startTransition(async () => {
      const result = await setMonitorEnabled(next);
      if (result.error) {
        setOn(!next);
        setError(result.error);
      } else if (result.message && result.message !== "Saved.") {
        // Saved, but the hub is still running on the old value — the one
        // outcome a switch cannot show by moving.
        setError(result.message);
      }
    });
  }

  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-4 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={cn(
              "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
              on ? "bg-primary/10 text-primary" : "bg-subtle text-muted-foreground",
            )}
          >
            <Binoculars className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <Label htmlFor="monitoring-enabled" className="text-sm font-semibold">
              Watchdog
            </Label>
            <p className="mt-1 text-xs text-muted-foreground">
              Turn the watchdog on or off. When off, the rules are not run and no alerts are sent.
            </p>
            {error ? <p className="mt-2 text-xs text-warning">{error}</p> : null}
          </div>
        </div>

        <Switch
          id="monitoring-enabled"
          checked={on}
          onCheckedChange={toggle}
          disabled={disabled || pending}
        />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

function RulesCard({
  rules,
  groups,
  enabled,
  deviceCount,
  capableCount,
  disabled,
}: {
  rules: MonitorRuleRow[];
  groups: GroupChoice[];
  enabled: boolean;
  deviceCount: number;
  capableCount: number;
  disabled: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");

  const needsAgent = rules.some((rule) => rule.enabled && signalMeta(rule.signal).needsAgent);
  const behind = deviceCount - capableCount;
  const on = rules.filter((rule) => rule.enabled).length;

  // Worth a search box only once the list is long enough to have to look
  // through; below that it is a control with nothing to do.
  const searchable = rules.length > 6;
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase();
    if (!words) return rules;
    return rules.filter((rule) =>
      `${rule.name} ${signalMeta(rule.signal).label} ${rule.packageName ?? ""}`
        .toLowerCase()
        .includes(words),
    );
  }, [rules, query]);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            <TriangleAlert className="h-4 w-4 text-muted-foreground" />
            Rules
            {rules.length > 0 ? (
              <span className="text-xs font-normal tabular-nums text-muted-foreground">
                {on} of {rules.length} on
              </span>
            ) : null}
          </CardTitle>
          <CardDescription className="mt-1">
            Each rule is a configurable probe that checks a box's state and takes action if it is
            wrong.
          </CardDescription>
        </div>

        {!disabled ? (
          <Button type="button" size="sm" className="shrink-0" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            New rule
          </Button>
        ) : null}
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {!enabled && on > 0 ? (
          <p className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
            Monitoring is disabled, no rules are run and no alerts are sent.
          </p>
        ) : null}

        {needsAgent && behind > 0 ? (
          <p className="rounded-lg border border-border bg-subtle p-3 text-xs text-muted-foreground">
            {behind} of {deviceCount} boxes run an agent from before monitoring existed. Rules that
            need the box to look at itself skip those rather than reading their silence as a fault —
            they update themselves in due course.
          </p>
        ) : null}

        {searchable ? (
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Search rules"
            aria-label="Search rules"
            className="max-w-xs"
          />
        ) : null}

        {rules.length === 0 ? (
          <EmptyRules disabled={disabled} onCreate={() => setCreating(true)} />
        ) : shown.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No rule matches that.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {shown.map((rule) => (
              <RuleRow key={rule.id} rule={rule} groups={groups} disabled={disabled} />
            ))}
          </div>
        )}
      </CardContent>

      {/* Mounted only while open, so an abandoned draft is not what the next
          "New rule" opens on. */}
      {creating ? (
        <MonitorRuleDialog groups={groups} open onOpenChange={() => setCreating(false)} />
      ) : null}
    </Card>
  );
}

/**
 * One rule, as much of it as reads at a glance.
 *
 * The whole row opens the editor, which is why the switch and the bin sit above
 * that hit area rather than inside it: turning a rule off is the thing people
 * come here to do most, and it should not cost opening the rule and saving it
 * back.
 */
function RuleRow({
  rule,
  groups,
  disabled,
}: {
  rule: MonitorRuleRow;
  groups: GroupChoice[];
  disabled: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Optimistic, because the round-trip includes telling the hub, and a switch
  // that sits still for that reads as a switch that did not take.
  const [on, setOn] = useState(rule.enabled);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [toggling, startToggle] = useTransition();

  const meta = signalMeta(rule.signal);
  const Icon = meta.icon;
  const group = rule.groupId ? groups.find((choice) => choice.id === rule.groupId) : null;

  function toggle(next: boolean) {
    setOn(next);
    setToggleError(null);
    startToggle(async () => {
      const result = await setMonitorRuleEnabled(rule.id, next);
      if (result.error) {
        setOn(!next);
        setToggleError(result.error);
      }
    });
  }

  return (
    <div
      className={cn(
        "rounded-lg border border-border transition-colors",
        "hover:border-border-emphasis hover:bg-subtle/50",
        !on && "opacity-70",
      )}
    >
      <div className="relative flex items-start gap-3 p-3">
        <span
          className={cn(
            "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
            on ? "bg-primary/10 text-primary" : "bg-subtle text-muted-foreground",
          )}
        >
          <Icon className="h-4 w-4" />
        </span>

        <button
          type="button"
          onClick={() => setEditing(true)}
          // The pseudo-element is the hit area, so the whole row opens the rule
          // while the controls to its right keep their own clicks.
          className="min-w-0 flex-1 text-left after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{rule.name}</span>
            {group ? <Badge variant="secondary">{group.name}</Badge> : null}
            <LevelBadge level={rule.notifyLevel} />
            {/* Which channels, not whether. "Announced" used to be the whole
                answer; now a rule can be loud in one place and silent in
                another, and the list is where somebody wondering why their
                phone stayed quiet looks first. */}
            {rule.notifyChannels.length > 0 ? (
              <Badge variant="secondary">
                <Bell className="h-3 w-3" />
                {rule.notifyChannels.length === CHANNEL_IDS.length
                  ? "Everywhere"
                  : rule.notifyChannels
                      .map((channel) => CHANNEL_LABELS[channel as MonitorChannel])
                      .join(", ")}
              </Badge>
            ) : (
              <Badge variant="outline">
                <BellOff className="h-3 w-3" />
                Quiet
              </Badge>
            )}
          </span>

          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {meta.label}
            {rule.threshold > 1 ? ` after ${rule.threshold} in a row` : ""}
            {rule.packageName ? ` · ${rule.packageName}` : ""}
            {rule.windowStart ? ` · ${rule.windowStart}–${rule.windowEnd}` : ""}
          </span>

          <Ladder steps={rule.steps} />
        </button>

        {!disabled ? (
          <div className="relative z-10 flex shrink-0 items-center gap-1">
            <Switch
              checked={on}
              onCheckedChange={toggle}
              disabled={toggling}
              aria-label={`${on ? "Disable" : "Enable"} ${rule.name}`}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setEditing(true)}
              aria-label={`Edit ${rule.name}`}
              className="hidden sm:inline-flex"
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={pending}
              onClick={() => setConfirmOpen(true)}
              aria-label={`Remove ${rule.name}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ) : null}
      </div>

      {/* A switch that sprang back needs to say why, and it is the only thing
          on this row that can fail without a dialog to say it in. */}
      {toggleError ? (
        <p className="border-t border-border px-3 py-2 text-xs text-destructive">{toggleError}</p>
      ) : null}

      {editing ? (
        <MonitorRuleDialog
          rule={rule}
          groups={groups}
          open
          onOpenChange={() => setEditing(false)}
        />
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Remove "${rule.name}"?`}
        description="The rule and its counters go."
        pending={pending}
        error={removeError}
        onConfirm={() => {
          startTransition(async () => {
            const result = await deleteMonitorRule(rule.id);
            setRemoveError(result.error ?? null);
            if (!result.error) setConfirmOpen(false);
          });
        }}
      />
    </div>
  );
}

/**
 * What a rule is worth saying, always — not only when it is the loud one.
 *
 * Only Critical used to carry a badge, which made a row with none of them
 * ambiguous: a warning and an info rule looked identical, and the level is
 * what the Discord minimum is weighed against.
 */
function LevelBadge({ level }: { level: string }) {
  if (level === "CRITICAL") return <Badge variant="danger">Critical</Badge>;
  if (level === "INFO") return <Badge variant="info">Info</Badge>;
  return <Badge variant="warning">Warning</Badge>;
}

/** The ladder as chips, in the order it is climbed. */
function Ladder({ steps }: { steps: MonitorRuleRow["steps"] }) {
  const sorted = [...steps].sort((a, b) => a.atFailure - b.atFailure);

  return (
    <span className="mt-2 flex flex-wrap items-center gap-1.5">
      {sorted.map((step, index) => {
        const meta = actionMeta(step.action);
        const Icon = meta.icon;
        return (
          <span key={`${step.atFailure}-${index}`} className="flex items-center gap-1.5">
            {index > 0 ? <span className="text-xs text-muted-foreground">→</span> : null}
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-4",
                // The rung that costs a box ten minutes should not look like
                // the one that force-stops an app.
                meta.hard
                  ? "border-warning/30 bg-warning/10 text-warning"
                  : "border-border bg-subtle text-muted-foreground",
              )}
            >
              <Icon className="h-3 w-3" />
              {meta.label}
            </span>
          </span>
        );
      })}
    </span>
  );
}

function EmptyRules({ disabled, onCreate }: { disabled: boolean; onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-10 text-center">
      <Binoculars className="h-6 w-6 text-muted-foreground" />
      <p className="max-w-md text-sm text-muted-foreground">
        No rules yet. A new rule starts switched off — nothing is probed and nothing is touched
        until you turn it on.
      </p>
      {!disabled ? (
        <Button type="button" variant="outline" size="sm" onClick={onCreate}>
          <Plus className="h-4 w-4" />
          Write the first one
        </Button>
      ) : null}
    </div>
  );
}
