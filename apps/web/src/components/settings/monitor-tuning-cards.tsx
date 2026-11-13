"use client";

import { useActionState, useState } from "react";
import { Binoculars } from "lucide-react";
import { updateMonitorSettings } from "@/actions/monitoring";
import type { ActionState } from "@/actions/rollouts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { SaveButton } from "@/components/ui/save-button";
import { NumberField, Outcome, SettingGroup } from "@/components/settings/setting-fields";
import type { MonitorSettingsRow } from "@/components/settings/monitoring-section";

/**
 * The monitoring knobs, on the Tuning tab rather than beside the rules.
 *
 * They are tuning, not policy: ceilings, graces and intervals, all of them
 * measured against numbers that were already here — the pass runs once per
 * heartbeat, and `AGENT_OFFLINE` fires on the offline timeout two cards up.
 * Kept next to what they are measured against, the couplings explain
 * themselves; a tab away, each one had to be restated in a hint.
 *
 * The Monitoring tab keeps what an operator actually edits day to day: the
 * switch, and the rules. Where alerts go, and how often the same one may be
 * repeated, is on the Notifications tab with every other message the fleet
 * sends.
 *
 * Still its own form, and still the `monitor.` group in the one `Setting`
 * table — same page, separate saves, so a half-typed ceiling cannot take the
 * heartbeat down with it.
 */

export function MonitorTuningCard({
  settings,
  disabled,
}: {
  settings: MonitorSettingsRow;
  disabled: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(updateMonitorSettings, {});
  // Mirrored out of its own input so the delay below can name its floor while
  // it is being typed, rather than after a save that the server rejects.
  const [rotomSync, setRotomSync] = useState(settings.rotomSyncSeconds);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Binoculars className="h-4 w-4 text-muted-foreground" />
          How it watches
        </CardTitle>
        <CardDescription>
          When a reading counts, and the ceilings that keep a rule which turns out to be wrong from
          restarting a fleet all night.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form action={formAction} className="flex flex-col gap-6">
          {/* Only the fields below are posted. The action reads an absent field
              as "this card does not own it" and keeps what is stored, so there
              is nothing here mirroring the master switch. */}

          {/* No heartbeat or offline readout here any more: both are real
              fields on the Hub settings card directly above, and a disabled
              copy of a number a screen away from its input reads as a second
              knob. What the pass is measured against is the heartbeat — once
              per beat, because a pass reads what the boxes last said and they
              say it once per beat. */}
          <SettingGroup title="Timing">
            <NumberField
              name="rotomSyncSeconds"
              label="Ask Rotom every"
              value={settings.rotomSyncSeconds}
              min={5}
              disabled={disabled}
              onValueChange={setRotomSync}
              hint="One request for the whole fleet, and only with the integration on. Rotom's own dashboard polls every 5s, which is why that is the floor."
            />
            <NumberField
              name="rotomStaleSeconds"
              label="Rotom stale after"
              value={settings.rotomStaleSeconds}
              // Two sync intervals: a box can never be known to be fresher
              // than the last time anyone asked Rotom about it.
              min={rotomSync * 2}
              disabled={disabled}
              hint={`How long since Rotom last saw a box before that counts as disconnected. Asking every ${rotomSync}s means anything under ${rotomSync * 2}s alerts on the sync's own lag rather than on a box.`}
            />
          </SettingGroup>

          <SettingGroup title="Grace">
            <NumberField
              name="rebootGraceSeconds"
              label="After a reboot"
              value={settings.rebootGraceSeconds}
              min={60}
              disabled={disabled}
              hint="Nothing touches a box for this long after Magnemite rebooted it. Without it, the box coming back slowly reads as a fault and it is rebooted again."
            />
            <NumberField
              name="startupGraceSeconds"
              label="After a hub restart"
              value={settings.startupGraceSeconds}
              min={0}
              disabled={disabled}
              hint="A restart drops every device socket at once and the fleet reconnects over the next few seconds. Nothing acts until that has settled."
            />
          </SettingGroup>

          <SettingGroup title="Ceilings">
            <NumberField
              name="maxActionsPerDeviceHour"
              label="Actions per box per hour"
              value={settings.maxActionsPerDeviceHour}
              min={1}
              unit="at most"
              disabled={disabled}
              hint="Past it, the box gets one critical alert."
            />
            <NumberField
              name="maxRebootsPerDeviceDay"
              label="Reboots per box per day"
              value={settings.maxRebootsPerDeviceDay}
              min={1}
              unit="at most"
              disabled={disabled}
              hint="The same, for the expensive half of the ladder. A reboot sent through Rotom counts here too — a different socket, the same boot cycle."
            />
          </SettingGroup>

          {/* The repeat window that used to sit beside this moved to the
              Notifications tab: it decides whether a message goes out, not
              whether a box is touched. */}
          <SettingGroup title="History">
            <NumberField
              name="eventRetentionDays"
              label="Keep history for"
              value={settings.eventRetentionDays}
              min={0}
              unit="days"
              disabled={disabled}
              hint="Set 0 to keep data history forever."
            />
          </SettingGroup>

          <SettingGroup title="Diagnostics">
            <label className="flex items-start justify-between gap-4">
              <span className="flex flex-col gap-1">
                <span className="text-sm font-medium">Collect logs when a box comes back</span>
                <span className="text-xs text-muted-foreground">
                  The window that explains an unreachable alert is gone by the time you read it —
                  live logs and the zip both need the box online. This grabs the box&apos;s own
                  agent.log on the way back instead, and files it against the outage. Off by
                  default: it runs a collection on the box and costs its uplink.
                </span>
              </span>
              <Switch
                name="autoCollectLogsOnRecovery"
                defaultChecked={settings.autoCollectLogsOnRecovery}
                disabled={disabled}
              />
            </label>
            <NumberField
              name="autoCollectMinIntervalMinutes"
              label="At most one per box every"
              value={settings.autoCollectMinIntervalMinutes}
              min={1}
              unit="minutes"
              disabled={disabled}
              hint="A box that flaps all night would otherwise be collected from all night."
            />
            <NumberField
              name="autoCollectMaxPerHour"
              label="Fleet-wide ceiling"
              value={settings.autoCollectMaxPerHour}
              min={1}
              unit="per hour"
              disabled={disabled}
              hint="An outage at the hub end brings every box back at once. Collecting from all of them together would be a second outage on top of the first."
            />
          </SettingGroup>

          <Outcome state={state} />
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
