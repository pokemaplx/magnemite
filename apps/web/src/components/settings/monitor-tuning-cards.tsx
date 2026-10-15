"use client";

import { useActionState, useState, useTransition } from "react";
import { Binoculars, MessageSquare, Send, Smartphone } from "lucide-react";
import { sendTestAlert, updateMonitorSettings } from "@/actions/monitoring";
import type { ActionState } from "@/actions/rollouts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SaveButton } from "@/components/ui/save-button";
import { NumberField, SettingGroup } from "@/components/settings/setting-fields";
import type { MonitorSettingsRow } from "@/components/settings/monitoring-section";

/**
 * The monitoring knobs, on the Hub tab rather than beside the rules.
 *
 * They are tuning, not policy: ceilings, graces and intervals, all of them
 * measured against numbers that were already here — the pass runs once per
 * heartbeat, and `AGENT_OFFLINE` fires on the offline timeout two cards up.
 * Kept next to what they are measured against, the couplings explain
 * themselves; a tab away, each one had to be restated in a hint.
 *
 * The Monitoring tab keeps what an operator actually edits day to day: the
 * switch, and the rules.
 *
 * Still their own forms, and still the `monitor.` group in the one `Setting`
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
              is nothing here mirroring the master switch or the Discord card. */}

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

          <SettingGroup title="Noise and history">
            <NumberField
              name="alertDedupeMinutes"
              label="Repeat an alert after"
              value={settings.alertDedupeMinutes}
              min={0}
              unit="minutes"
              disabled={disabled}
              hint="The same signal on the same box is not announced again inside this. The action still happens; only the message is held."
            />
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

/**
 * The one outcome a save button cannot show: saved, but the hub could not be
 * told, so it is still running on the old values.
 */
function Outcome({ state }: { state: ActionState }) {
  if (state.error) return <p className="text-sm text-destructive">{state.error}</p>;
  if (state.ok && state.message && state.message !== "Saved.") {
    return <p className="text-sm text-warning">{state.message}</p>;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

export function MonitorDiscordCard({
  settings,
  disabled,
}: {
  settings: MonitorSettingsRow;
  disabled: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(updateMonitorSettings, {});
  const [test, setTest] = useState<ActionState>({});
  const [pending, startTransition] = useTransition();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          Discord
        </CardTitle>
        <CardDescription>
          Where alerts go, configured in the channel&rsquo;s Integrations settings. Empty turns
          notifications off and leaves the rules running.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {/* Only this card's fields are posted: the action keeps the timings
            and ceilings the other card owns. This form used to mirror them in
            hidden inputs, and one of them was missing — which is what made
            saving a webhook fail over a number that is not on this card. */}
        <form action={formAction} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="discordWebhookUrl">Webhook URL</Label>
            <Input
              id="discordWebhookUrl"
              name="discordWebhookUrl"
              type="url"
              placeholder="https://discord.com/api/webhooks/…"
              defaultValue={settings.discordWebhookUrl}
              disabled={disabled}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              From the channel&rsquo;s Integrations settings. Empty turns notifications off and
              leaves the rules running.
            </p>
          </div>

          {/* No minimum severity here any more. Which rules reach Discord is
              the rules' own answer, on each rule — two filters in series meant
              a rule set to announce could silently not, with nothing on it to
              say why. */}
          <div className="flex flex-col gap-1.5 sm:max-w-xs">
            <Label htmlFor="discordMentionRoleId">Role to ping (optional)</Label>
            <Input
              id="discordMentionRoleId"
              name="discordMentionRoleId"
              placeholder="123456789012345678"
              defaultValue={settings.discordMentionRoleId}
              disabled={disabled}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">Pinged on critical alerts only.</p>
          </div>

          <Outcome state={state} />
          {test.error ? <p className="text-sm text-destructive">{test.error}</p> : null}
          {test.ok ? <p className="text-sm text-success">{test.message}</p> : null}

          {!disabled ? (
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  startTransition(async () => setTest(await sendTestAlert()));
                }}
              >
                <Send className="h-4 w-4" />
                Send test alert
              </Button>
              <SaveButton state={state} />
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ntfy
// ---------------------------------------------------------------------------

export function MonitorNtfyCard({
  settings,
  disabled,
}: {
  settings: MonitorSettingsRow;
  disabled: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(updateMonitorSettings, {});
  const [test, setTest] = useState<ActionState>({});
  const [pending, startTransition] = useTransition();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-muted-foreground" />
          ntfy
        </CardTitle>
        <CardDescription>
          A push notification on a phone, without an account anywhere. Empty topic turns it off and
          leaves the rules running.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {/* Only this card's four fields are posted, and the action keeps
            everything it does not see — the same contract the Discord card
            relies on. */}
        <form action={formAction} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ntfyUrl">Server</Label>
              <Input
                id="ntfyUrl"
                name="ntfyUrl"
                type="url"
                placeholder="https://ntfy.sh"
                defaultValue={settings.ntfyUrl}
                disabled={disabled}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                The public ntfy.sh, or your own. Install the ntfy app and subscribe to the topic.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ntfyTopic">Topic</Label>
              <Input
                id="ntfyTopic"
                name="ntfyTopic"
                placeholder="magnemite-3f9a2c"
                defaultValue={settings.ntfyTopic}
                disabled={disabled}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                On ntfy.sh anyone who guesses the topic reads your alerts, so pick a name nobody
                would.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-1.5 sm:max-w-xs">
            <Label htmlFor="ntfyToken">Access token (optional)</Label>
            <Input
              id="ntfyToken"
              name="ntfyToken"
              type="password"
              placeholder="tk_…"
              defaultValue={settings.ntfyToken}
              disabled={disabled}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Only for a protected or reserved topic. Empty publishes anonymously.
            </p>
          </div>

          <Outcome state={state} />
          {test.error ? <p className="text-sm text-destructive">{test.error}</p> : null}
          {test.ok ? <p className="text-sm text-success">{test.message}</p> : null}

          {!disabled ? (
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  startTransition(async () => setTest(await sendTestAlert()));
                }}
              >
                <Send className="h-4 w-4" />
                Send test alert
              </Button>
              <SaveButton state={state} />
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
