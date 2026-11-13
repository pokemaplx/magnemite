"use client";

import { useActionState, useEffect } from "react";
import { SlidersHorizontal } from "lucide-react";
import { updateHubSettings, type HubSettingsState } from "@/actions/settings";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SaveButton } from "@/components/ui/save-button";
import { useToast } from "@/components/ui/toast";
import { NumberField, SettingGroup } from "@/components/settings/setting-fields";

export type HubSettingsRow = {
  maxConcurrentJobs: number;
  jobStallTimeoutSeconds: number;
  joinInstallDelaySeconds: number;
  heartbeatSeconds: number;
  agentUpdateConcurrency: number;
  configRewriteConcurrency: number;
  deviceOfflineTimeoutSeconds: number;
};

/**
 * The fleet-wide knobs, in three groups.
 *
 * They used to be one grid ten fields long, in the order they happened to be
 * added: the heartbeat sat between a sample interval and an agent concurrency,
 * and the offline timeout — which is measured in heartbeats — was four rows
 * away from it. Grouped, the couplings sit next to each other, which is the
 * only way the numbers explain themselves.
 */
export function HubSettingsForm({
  settings,
  disabled,
}: {
  settings: HubSettingsRow;
  disabled: boolean;
}) {
  const [state, formAction] = useActionState<HubSettingsState, FormData>(updateHubSettings, {});
  const toast = useToast();

  // The heartbeat is the only knob here whose save has anywhere else to reach,
  // so it is the only one with an outcome the card cannot show by itself. The
  // count comes back as a number: a save that left the heartbeat alone sends
  // none, and toasts nothing.
  useEffect(() => {
    const pushed = state.pushed;
    if (!state.ok || !pushed) return;
    toast(`Saved. ${pushed} box${pushed === 1 ? "" : "es"} took the new heartbeat.`);
  }, [state, toast]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
          Hub settings
        </CardTitle>
        <CardDescription>
          Fleet-wide operational knobs. Changes take effect within a few seconds, no restart needed.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form action={formAction} className="flex flex-col gap-6">
          <SettingGroup title="The beat" hint="">
            <NumberField
              name="heartbeatSeconds"
              label="Heartbeat"
              value={settings.heartbeatSeconds}
              min={5}
              disabled={disabled}
              hint="How often each box reports in."
            />
            <NumberField
              name="deviceOfflineTimeoutSeconds"
              label="Offline after"
              value={settings.deviceOfflineTimeoutSeconds}
              min={30}
              disabled={disabled}
              hint="Silence from a box before it is marked offline, really how many missed beats you will tolerate."
            />
          </SettingGroup>

          <SettingGroup title="Installing">
            <NumberField
              name="maxConcurrentJobs"
              label="Concurrent installs"
              value={settings.maxConcurrentJobs}
              min={1}
              unit="boxes"
              disabled={disabled}
              hint="Fleet-wide cap on boxes downloading at once."
            />
            <NumberField
              name="agentUpdateConcurrency"
              label="Concurrent agent updates"
              value={settings.agentUpdateConcurrency}
              min={1}
              unit="boxes"
              disabled={disabled}
              hint="How many boxes may swap their agent binary at once. The whole fleet reconnecting after a hub deploy is when this matters."
            />
            <NumberField
              name="configRewriteConcurrency"
              label="Concurrent config rewrites"
              value={settings.configRewriteConcurrency}
              min={1}
              unit="boxes"
              disabled={disabled}
              hint="How many boxes may have their MITM config rewritten at once when their workers change. Each one restarts that box's scanner, so this is how much of the fleet stops scanning together."
            />
            <NumberField
              name="jobStallTimeoutSeconds"
              label="Job stalls after"
              value={settings.jobStallTimeoutSeconds}
              min={1}
              disabled={disabled}
              hint="Silence from a box mid-job before that job is re-queued to it."
            />
            <NumberField
              name="joinInstallDelaySeconds"
              label="New boxes settle for"
              value={settings.joinInstallDelaySeconds}
              min={0}
              disabled={disabled}
              hint="How long after it boots a box waits before its group's join installs start. 0 installs on enrolment."
            />
          </SettingGroup>

          {/* No history group here any more: it is its own card below, because
              there are two of them now and they are floored by two different
              numbers — this heartbeat, and the Rotom sync on the Monitoring
              card. */}

          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          {/* The button reports a plain save on its own. This is for the one
              outcome it cannot show: saved, but the hub was not reachable to
              be told, so it is still running on the old numbers. */}
          {state.ok && state.message && state.message !== "Saved." ? (
            <p className="text-sm text-warning">{state.message}</p>
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
