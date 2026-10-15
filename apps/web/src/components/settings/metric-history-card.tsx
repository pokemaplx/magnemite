"use client";

import { useActionState } from "react";
import { ChartLine } from "lucide-react";
import { updateMetricHistory } from "@/actions/settings";
import type { ActionState } from "@/actions/rollouts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SaveButton } from "@/components/ui/save-button";
import { NumberField, SettingGroup } from "@/components/settings/setting-fields";

export type MetricHistoryRow = {
  metricsSampleSeconds: number;
  metricsRetentionDays: number;
  rotomSampleSeconds: number;
  rotomRetentionDays: number;
  connectionRetentionDays: number;
  /** The floors, from the two cards that own them. Shown, never posted. */
  heartbeatSeconds: number;
  rotomSyncSeconds: number;
};

/**
 * How much history to keep, in two pairs.
 *
 * One card because both answer the same two questions — how often to keep one,
 * and how long it lives — and two groups because the answers are independent.
 * They were one pair once, shared, and that made the scanner history inherit a
 * rule about heartbeats: it could never be finer than a beat, though Rotom is
 * asked more than twice as often as one.
 *
 * Each group names the number it is floored by rather than restating it as a
 * rule, because that number lives on a different card and "60s, the heartbeat"
 * is the whole explanation.
 */
export function MetricHistoryCard({
  settings,
  disabled,
}: {
  settings: MetricHistoryRow;
  disabled: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(updateMetricHistory, {});

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ChartLine className="h-4 w-4 text-muted-foreground" />
          Metric history
        </CardTitle>
        <CardDescription>
          What the charts are drawn from, sample timing and retention.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form action={formAction} className="flex flex-col gap-6">
          <SettingGroup title="Device metrics">
            <NumberField
              name="metricsSampleSeconds"
              label="Sample every"
              value={settings.metricsSampleSeconds}
              min={settings.heartbeatSeconds}
              disabled={disabled}
              hint={`A box's CPU, memory, storage, temperature and per-app usage. Devices report every ${settings.heartbeatSeconds}s, so that is the floor.`}
            />
            <NumberField
              name="metricsRetentionDays"
              label="Keep for"
              value={settings.metricsRetentionDays}
              min={0}
              unit="days"
              disabled={disabled}
              hint="0 turns device recording off and drops what is already stored."
            />
          </SettingGroup>

          <SettingGroup title="Rotom metrics">
            <NumberField
              name="rotomSampleSeconds"
              label="Sample every"
              value={settings.rotomSampleSeconds}
              min={settings.rotomSyncSeconds}
              disabled={disabled}
              hint={`Workers, request rate and the four Rotom flags, behind a box's scanner page. Rotom is asked every ${settings.rotomSyncSeconds}s, so that is the floor.`}
            />
            <NumberField
              name="rotomRetentionDays"
              label="Keep for"
              value={settings.rotomRetentionDays}
              min={0}
              unit="days"
              disabled={disabled}
              hint="0 turns scanner recording off. The Scanner column and the monitoring rules are unaffected, they read the live state, not the history."
            />
          </SettingGroup>

          {/* No sampling pair here, deliberately: an episode is written when
              one happens rather than on a clock, so "how often" has no
              meaning for it. Only how long to keep it. */}
          <SettingGroup title="Connectivity">
            <NumberField
              name="connectionRetentionDays"
              label="Keep for"
              value={settings.connectionRetentionDays}
              min={0}
              unit="days"
              disabled={disabled}
              hint="Every stretch where a box was out of contact, and what it was — the history behind an unreachable alert. One row per episode rather than one per beat, so months of it costs almost nothing. 0 turns it off and drops what is stored."
            />
          </SettingGroup>

          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          {state.ok && state.message && state.message !== "Saved." ? (
            <p className="text-sm text-muted-foreground">{state.message}</p>
          ) : null}

          {!disabled ? (
            <div className="flex justify-end">
              <SaveButton state={state} />
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
