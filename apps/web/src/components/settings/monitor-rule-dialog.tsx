"use client";

import { useActionState, useEffect, useState, type ReactNode } from "react";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { createMonitorRule, updateMonitorRule } from "@/actions/monitoring";
import type { MonitorChannel } from "@magnemite/db";
import type { ActionState } from "@/actions/rollouts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveButton } from "@/components/ui/save-button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  ACTION_OPTIONS,
  actionMeta,
  CHANNEL_IDS,
  CHANNEL_LABELS,
  defaultProbeKind,
  LEVEL_OPTIONS,
  PROBE_OPTIONS,
  SIGNAL_OPTIONS,
  signalMeta,
} from "@/lib/monitor-vocabulary";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type MonitorStepRow = {
  atFailure: number;
  action: string;
  command: string | null;
};

export type MonitorRuleRow = {
  id: string;
  name: string;
  enabled: boolean;
  signal: string;
  packageName: string | null;
  groupId: string | null;
  threshold: number;
  cooldownSeconds: number;
  windowStart: string | null;
  windowEnd: string | null;
  notifyLevel: string;
  notifyChannels: string[];
  notifyRecovery: boolean;
  probe: {
    kind: string;
    target: string;
    expect: string | null;
    lines: number;
    failAt: number;
    successPattern: string | null;
    maxRatio: number | null;
    maxAgeSeconds: number | null;
    timeoutSeconds: number;
  } | null;
  steps: MonitorStepRow[];
};

export type GroupChoice = { id: string; name: string };

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

/**
 * One rule, on its own, in front of everything else.
 *
 * A rule is a dozen fields and a ladder, and it used to unfold inside the list
 * — which meant the list jumped as it opened, the rule being edited was as
 * wide as a table row, and the rules above it were still competing for
 * attention. In a modal there is one rule on screen and the fields have room
 * to be grouped in the order somebody thinks in: what to watch, how to tell,
 * when it counts, what to do about it.
 *
 * Unmounted while closed — Radix does that — so opening a rule always starts
 * from what is stored rather than from what was typed and abandoned last time.
 */
export function MonitorRuleDialog({
  rule,
  groups,
  open,
  onOpenChange,
}: {
  /** Absent for a new rule. */
  rule?: MonitorRuleRow;
  groups: GroupChoice[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The form owns the scrolling, so its header and footer can stay put
          while a long ladder scrolls between them. */}
      <DialogContent className="max-w-2xl overflow-y-hidden p-0">
        <RuleForm rule={rule} groups={groups} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * One rule, create and edit alike.
 *
 * Shared so the two cannot drift — a rule that could be created but not saved
 * again would be a miserable bug to track down, and the server action parses
 * both with the same function for the same reason.
 */
function RuleForm({
  rule,
  groups,
  onDone,
}: {
  rule?: MonitorRuleRow;
  groups: GroupChoice[];
  onDone: () => void;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    rule ? updateMonitorRule : createMonitorRule,
    {},
  );
  const [signal, setSignal] = useState(rule?.signal ?? "SERVICE_DOWN");
  const [probeKind, setProbeKind] = useState(rule?.probe?.kind ?? "none");
  // Lifted out of its own Toggle only because the all-clear switch below it
  // has nothing to mean while this is off.
  const [channels, setChannels] = useState<MonitorChannel[]>(
    () => (rule?.notifyChannels as MonitorChannel[] | undefined) ?? [...CHANNEL_IDS],
  );
  const [steps, setSteps] = useState<MonitorStepRow[]>(
    rule?.steps.length
      ? [...rule.steps].sort((a, b) => a.atFailure - b.atFailure)
      : [{ atFailure: 1, action: "NOTIFY_ONLY", command: null }],
  );

  const meta = signalMeta(signal);

  // A save that landed has nothing left to say, and a modal sitting open on it
  // makes people wonder whether it took. The one exception is a save the hub
  // was not told about, which is a sentence somebody has to read.
  const stale = Boolean(state.message?.includes("could not be told"));
  useEffect(() => {
    if (state.ok && !stale) onDone();
  }, [state, stale, onDone]);

  const groupOptions = [
    { value: "", label: "Every box" },
    ...groups.map((group) => ({ value: group.id, label: group.name })),
  ];

  // Switching to a signal only a probe can answer must not leave the form on
  // "No probe" — a rule that looks complete and can never fire.
  function pickSignal(next: string) {
    setSignal(next);
    if (signalMeta(next).probe === "required" && probeKind === "none") {
      setProbeKind(defaultProbeKind(next));
    }
  }

  const id = (field: string) => `${field}-${rule?.id ?? "new"}`;

  return (
    <form action={formAction} className="flex max-h-[85vh] flex-col">
      <DialogHeader className="mb-0 shrink-0 border-b border-border px-6 py-4 pr-12">
        <DialogTitle>{rule ? rule.name : "New rule"}</DialogTitle>
        <DialogDescription>Configure this rule. A signal to watch for.</DialogDescription>
      </DialogHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-5">
        {rule ? <input type="hidden" name="ruleId" value={rule.id} /> : null}

        {/* Name and scope carry no heading of their own: they are what the
            rule is called and where it applies, not part of any of the four
            questions below. */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor={id("name")}>
            <Input
              id={id("name")}
              name="name"
              defaultValue={rule?.name}
              placeholder="Scanner offline"
              required
            />
          </Field>

          <Field
            label="Applies to"
            htmlFor={id("groupId")}
            hint="A rule scoped to a group replaces the fleet-wide one for that group rather than adding to it."
          >
            <Select
              id={id("groupId")}
              name="groupId"
              options={groupOptions}
              defaultValue={rule?.groupId ?? ""}
            />
          </Field>
        </div>

        {/* --- what it watches ---------------------------------------------- */}
        <Section title="What it watches">
          <Field label="Signal" htmlFor={id("signal")} hint={meta.hint}>
            <Select
              id={id("signal")}
              name="signal"
              options={SIGNAL_OPTIONS}
              value={signal}
              onValueChange={pickSignal}
            />
          </Field>

          <Field
            label={meta.needsPackage ? "App package" : "App package (optional)"}
            htmlFor={id("packageName")}
            hint={
              meta.needsPackage
                ? "The signal is about this app, so the rule needs it. Actions act on it too."
                : "What the actions act on. {pkg} in a command becomes this."
            }
          >
            <Input
              id={id("packageName")}
              name="packageName"
              defaultValue={rule?.packageName ?? ""}
              placeholder="com.nianticlabs.pokemongo"
              className="font-mono text-xs"
            />
          </Field>
        </Section>

        {/* --- how it is told ----------------------------------------------- */}
        {meta.probe === "none" ? null : (
          <Section
            title="How it is told"
            hint="The probe runs on the box every heartbeat, inside half the beat. Whatever does not finish reports a failure."
          >
            <ProbeFields
              probe={rule?.probe ?? null}
              probeKind={probeKind}
              onProbeKind={setProbeKind}
              // A signal nothing else can answer has no "No probe" to pick.
              options={
                meta.probe === "required"
                  ? PROBE_OPTIONS.filter((option) => option.value !== "none")
                  : PROBE_OPTIONS
              }
              id={id}
            />
          </Section>
        )}

        {/* --- when it counts ------------------------------------------------ */}
        <Section title="When it counts">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Bad readings in a row"
              htmlFor={id("threshold")}
              hint="Before the ladder starts. One acts on the first bad reading."
            >
              <Input
                id={id("threshold")}
                name="threshold"
                type="number"
                min={1}
                defaultValue={rule?.threshold ?? 1}
              />
            </Field>

            <Field
              label="Cooldown"
              htmlFor={id("cooldownSeconds")}
              hint="The least time between two actions from this rule on one box."
            >
              <Suffixed suffix="seconds">
                <Input
                  id={id("cooldownSeconds")}
                  name="cooldownSeconds"
                  type="number"
                  min={0}
                  defaultValue={rule?.cooldownSeconds ?? 300}
                />
              </Suffixed>
            </Field>
          </div>

          <Field
            label="Only act between"
            htmlFor={id("windowStart")}
            hint="Both empty means any hour. Alerts still go out outside the window."
          >
            <div className="flex items-center gap-2">
              <Input
                id={id("windowStart")}
                name="windowStart"
                type="time"
                defaultValue={rule?.windowStart ?? ""}
                className="max-w-[9rem]"
              />
              <span className="text-sm text-muted-foreground">and</span>
              <Input
                name="windowEnd"
                type="time"
                aria-label="Window end"
                defaultValue={rule?.windowEnd ?? ""}
                className="max-w-[9rem]"
              />
            </div>
          </Field>
        </Section>

        {/* --- what it does -------------------------------------------------- */}
        <Section
          title="What it does about it"
          hint="One rung per failure count, softest first. A rung already spent is not spent again, so a box that has proved a restart does not help is not restarted forever (except the last rung, which repeats at the cooldown because there is nothing stronger left to try)."
        >
          <StepsEditor steps={steps} onChange={setSteps} />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Severity"
              htmlFor={id("notifyLevel")}
              hint="How loud it looks: the Discord colour, ntfy's priority, whether a browser notification stays put."
            >
              <Select
                id={id("notifyLevel")}
                name="notifyLevel"
                options={LEVEL_OPTIONS}
                defaultValue={rule?.notifyLevel ?? "WARN"}
              />
            </Field>

            <ChannelPicker id={id("notifyChannels")} value={channels} onChange={setChannels} />

            {/* Nothing to say an all-clear about on a rule that announces
                nowhere, and a switch that does nothing is worse than an absent
                one. Unmounted rather than disabled, so the form posts nothing
                for it and the value follows what is on screen. */}
            {channels.length > 0 ? (
              <Toggle
                id={id("notifyRecovery")}
                name="notifyRecovery"
                label="Announce the all-clear"
                hint="A second message when the fault clears, on the same channels. Off, only the fault is announced."
                defaultChecked={rule?.notifyRecovery ?? false}
              />
            ) : null}
          </div>
        </Section>
      </div>

      <div className="shrink-0 border-t border-border px-6 py-4">
        {state.error ? <p className="mb-3 text-sm text-destructive">{state.error}</p> : null}
        {state.ok && stale ? <p className="mb-3 text-sm text-warning">{state.message}</p> : null}

        <div className="flex flex-wrap items-center justify-between gap-4">
          <label className="flex items-center gap-2.5 text-sm">
            <Switch name="enabled" defaultChecked={rule?.enabled ?? false} />
            <span className="font-medium">Enabled</span>
          </label>

          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <SaveButton state={state}>{rule ? "Save rule" : "Create rule"}</SaveButton>
          </div>
        </div>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

function ProbeFields({
  probe,
  probeKind,
  onProbeKind,
  options,
  id,
}: {
  probe: MonitorRuleRow["probe"];
  probeKind: string;
  onProbeKind: (kind: string) => void;
  options: { value: string; label: string }[];
  id: (field: string) => string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Probe"
        htmlFor={id("probeKind")}
        hint={
          probeKind === "none"
            ? "Answered by the hub from what the box last reported. Nothing runs on the box."
            : undefined
        }
      >
        <Select
          id={id("probeKind")}
          name="probeKind"
          options={options}
          value={probeKind}
          onValueChange={onProbeKind}
        />
      </Field>

      {probeKind === "none" ? null : (
        <div className="flex flex-col gap-4 rounded-lg border border-border bg-subtle/40 p-3">
          <Field
            label={
              probeKind === "shell"
                ? "Command"
                : probeKind === "http"
                  ? "URL"
                  : "Log file on the box"
            }
            htmlFor={id("probeTarget")}
          >
            <Input
              id={id("probeTarget")}
              name="probeTarget"
              defaultValue={probe?.target ?? ""}
              placeholder={
                probeKind === "shell"
                  ? "dumpsys activity services | grep -e MappingService"
                  : probeKind === "http"
                    ? "http://127.0.0.1:8080/health"
                    : "/data/local/tmp/atlas.log"
              }
              className="font-mono text-xs"
            />
          </Field>

          {probeKind === "http" ? null : (
            <Field
              label={probeKind === "shell" ? "Output must match" : "A fault looks like"}
              htmlFor={id("probeExpect")}
            >
              <Input
                id={id("probeExpect")}
                name="probeExpect"
                defaultValue={probe?.expect ?? ""}
                placeholder={probeKind === "shell" ? "(optional regex)" : "loop has been stalled"}
                className="font-mono text-xs"
              />
            </Field>
          )}

          {probeKind === "logMatch" ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Lines to read" htmlFor={id("probeLines")}>
                <Input
                  id={id("probeLines")}
                  name="probeLines"
                  type="number"
                  min={1}
                  defaultValue={probe?.lines ?? 200}
                />
              </Field>

              <Field label="Faults before it counts" htmlFor={id("probeFailAt")}>
                <Input
                  id={id("probeFailAt")}
                  name="probeFailAt"
                  type="number"
                  min={1}
                  defaultValue={probe?.failAt ?? 1}
                />
              </Field>

              <Field
                label="Work getting done looks like"
                htmlFor={id("probeSuccessPattern")}
                hint="Optional. Some faults are normal under load and only mean something when they outnumber the work beside them."
              >
                <Input
                  id={id("probeSuccessPattern")}
                  name="probeSuccessPattern"
                  defaultValue={probe?.successPattern ?? ""}
                  placeholder="I \| Worker"
                  className="font-mono text-xs"
                />
              </Field>

              <Field
                label="Faults per line of work"
                htmlFor={id("probeMaxRatio")}
                hint="Optional, and only means anything with the pattern beside it. Above this ratio, the reading counts as a fault."
              >
                <Input
                  id={id("probeMaxRatio")}
                  name="probeMaxRatio"
                  type="number"
                  min={0}
                  step="0.1"
                  defaultValue={probe?.maxRatio ?? ""}
                />
              </Field>

              <Field
                label="Stale after"
                htmlFor={id("probeMaxAgeSeconds")}
                hint="Optional. Also fail when nothing has been written to the log for this long, which is what a stalled loop looks like from outside."
              >
                <Suffixed suffix="seconds">
                  <Input
                    id={id("probeMaxAgeSeconds")}
                    name="probeMaxAgeSeconds"
                    type="number"
                    min={1}
                    defaultValue={probe?.maxAgeSeconds ?? ""}
                  />
                </Suffixed>
              </Field>
            </div>
          ) : null}

          <Field
            label="Give up after"
            htmlFor={id("probeTimeoutSeconds")}
            hint="A probe that runs long is cut off and reports nothing, which counts as neither a fault nor a recovery."
          >
            <Suffixed suffix="seconds">
              <Input
                id={id("probeTimeoutSeconds")}
                name="probeTimeoutSeconds"
                type="number"
                min={1}
                defaultValue={probe?.timeoutSeconds ?? 10}
                className="max-w-[8rem]"
              />
            </Suffixed>
          </Field>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

function StepsEditor({
  steps,
  onChange,
}: {
  steps: MonitorStepRow[];
  onChange: (steps: MonitorStepRow[]) => void;
}) {
  // The overrides are for the fleet that needs them and noise for everyone
  // else, so they start folded — unless this rule already carries one, where
  // hiding it would be hiding what the rule does.
  const [showCommands, setShowCommands] = useState(steps.some((step) => step.command));

  const update = (index: number, patch: Partial<MonitorStepRow>) => {
    onChange(steps.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  };

  return (
    <div className="flex flex-col gap-2">
      {steps.map((step, index) => {
        const meta = actionMeta(step.action);
        // Every row submits a command field whether or not one is shown: the
        // server reads the three columns as parallel arrays, and a row that
        // skipped its command would shift every command below it up a rung.
        const showCommand = showCommands || meta.needsCommand;

        return (
          <div
            key={index}
            className="flex flex-col gap-2 rounded-lg border border-border bg-subtle/40 p-2.5"
          >
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-xs text-muted-foreground">After</span>
              <Input
                name="stepAtFailure"
                type="number"
                min={1}
                aria-label="After this many failures"
                value={step.atFailure}
                onChange={(event) => update(index, { atFailure: Number(event.target.value) })}
                className="w-16 shrink-0 px-2 text-center"
              />
              <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                {step.atFailure === 1 ? "failure" : "failures"}
              </span>

              <Select
                name="stepAction"
                options={ACTION_OPTIONS}
                value={step.action}
                onValueChange={(value) => update(index, { action: value })}
                aria-label="Action"
                // The expensive rung reads as expensive without a legend.
                className={cn("min-w-0 flex-1", meta.hard && "text-warning")}
              />

              <Button
                type="button"
                variant="ghost"
                size="icon"
                // The ladder must keep at least one rung; a rule with none would
                // detect a fault and then do nothing at all with it.
                disabled={steps.length === 1}
                onClick={() => onChange(steps.filter((_, i) => i !== index))}
                aria-label={`Remove rung ${index + 1}`}
                className="shrink-0"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>

            {showCommand ? (
              <Input
                name="stepCommand"
                className="font-mono text-xs"
                aria-label="Command override"
                placeholder={
                  meta.needsCommand
                    ? "am force-stop {pkg}"
                    : "Leave empty for the default this action runs"
                }
                value={step.command ?? ""}
                onChange={(event) => update(index, { command: event.target.value || null })}
              />
            ) : (
              <input type="hidden" name="stepCommand" value={step.command ?? ""} />
            )}
          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            onChange([
              ...steps,
              {
                atFailure: Math.max(...steps.map((step) => step.atFailure), 0) + 1,
                action: "REBOOT",
                command: null,
              },
            ])
          }
        >
          <Plus className="h-4 w-4" />
          Add a rung
        </Button>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowCommands((was) => !was)}
        >
          {showCommands ? "Hide command overrides" : "Command overrides"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h4 className="text-sm font-semibold">{title}</h4>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** A unit beside a number, so the label does not have to carry "(seconds)". */
function Suffixed({ suffix, children }: { suffix: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">{children}</div>
      <span className="shrink-0 text-xs text-muted-foreground">{suffix}</span>
    </div>
  );
}

/**
 * Which channels this rule announces to.
 *
 * A dropdown of checkboxes rather than a row of them, so it keeps the shape
 * of the `Field` and `Toggle` beside it in the grid — three rows: label, one
 * input-tall box, hint. Three inline checkboxes were a whole line taller than
 * its neighbours and read as a broken form.
 *
 * The value is posted as one comma-joined hidden input rather than as a
 * checkbox per channel. Absent means "none" here, and with checkboxes the
 * browser posts nothing for the unchecked ones — so "announce nowhere" and
 * "this form does not own the field" would have arrived identically.
 */
function ChannelPicker({
  id,
  value,
  onChange,
}: {
  id: string;
  value: MonitorChannel[];
  onChange: (next: MonitorChannel[]) => void;
}) {
  const toggle = (channel: MonitorChannel) => {
    onChange(
      value.includes(channel)
        ? value.filter((entry) => entry !== channel)
        : // Kept in CHANNEL_IDS order rather than click order, so two
          // rules with the same channels read the same in the list.
          CHANNEL_IDS.filter((entry) => entry === channel || value.includes(entry)),
    );
  };

  const summary =
    value.length === 0
      ? "Nowhere"
      : value.length === CHANNEL_IDS.length
        ? "Everywhere"
        : value.map((channel) => CHANNEL_LABELS[channel]).join(", ");

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>Announce it</Label>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            id={id}
            type="button"
            className="flex h-9 items-center justify-between gap-3 rounded-lg border border-input bg-card px-3 text-left"
          >
            <span className={cn("truncate text-sm", value.length === 0 && "text-muted-foreground")}>
              {summary}
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        {/* As wide as the button that opened it, so it reads as that control
            opening rather than as a menu landing on top of it. Radix measures
            the trigger and hands the width over in this variable; a fixed
            width would drift from the grid column the field sits in. */}
        <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
          {CHANNEL_IDS.map((channel) => (
            <DropdownMenuItem
              key={channel}
              // Without this the menu closes on the first tick, and picking two
              // channels means opening it twice.
              onSelect={(event) => {
                event.preventDefault();
                toggle(channel);
              }}
            >
              <Checkbox checked={value.includes(channel)} className="pointer-events-none" />
              {CHANNEL_LABELS[channel]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <input type="hidden" name="notifyChannels" value={value.join(",")} />
      <p className="text-xs text-muted-foreground">
        Nowhere, and the rule still acts, quietly. A channel that is not set up in the cards above
        is skipped.
      </p>
    </div>
  );
}

function Toggle({
  id,
  name,
  label,
  hint,
  defaultChecked,
  onChange,
}: {
  id: string;
  name: string;
  label: string;
  hint: string;
  defaultChecked: boolean;
  onChange?: (on: boolean) => void;
}) {
  // Controlled only so the box can say which way it is set. Radix still writes
  // the hidden `name` input either way, so the form reads the same.
  const [on, setOn] = useState(defaultChecked);

  // Deliberately the same three rows as `Field` — label, a control box one
  // input tall, hint — because it sits in a grid beside one. Carrying its
  // label inside the box instead left it a whole line higher than the select
  // next to it, which read as a misaligned form rather than a different
  // control.
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex h-9 items-center justify-between gap-3 rounded-lg border border-input bg-card px-3">
        <span className="text-sm text-muted-foreground">{on ? "On" : "Off"}</span>
        <Switch
          id={id}
          name={name}
          checked={on}
          onCheckedChange={(next) => {
            setOn(next);
            onChange?.(next);
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
