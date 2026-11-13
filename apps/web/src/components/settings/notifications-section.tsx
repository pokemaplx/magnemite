"use client";

import { Fragment, useActionState } from "react";
import { Binoculars, Megaphone } from "lucide-react";
import type { NotifyChannel, NotifyEventId } from "@magnemite/db";
import { updateNotificationEvents, updateNotificationSettings } from "@/actions/notifications";
import type { ActionState } from "@/actions/rollouts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { SaveButton } from "@/components/ui/save-button";
import { DiscordCard, NtfyCard } from "@/components/settings/notification-channel-cards";
import { NumberField, Outcome, SettingGroup } from "@/components/settings/setting-fields";
import { WebPushCard } from "@/components/settings/web-push-card";
import { CHANNEL_IDS, CHANNEL_LABELS } from "@/lib/monitor-vocabulary";
import { NOTIFY_EVENT_GROUPS, NOTIFY_EVENT_META } from "@/lib/notify-vocabulary";

/**
 * Settings → Notifications: where everything the fleet says goes.
 *
 * Read top to bottom in the order it is set up: the channels first, because
 * nothing below means anything until one of them is; then which fleet events
 * go to which of them; then the one knob monitoring alerts have here. The
 * rules themselves stay on the Monitoring tab — each picks its own channels,
 * and that choice belongs beside what the rule watches.
 */

/**
 * The `notify.` settings as the cards read them.
 *
 * For a VIEWER the page blanks the webhook, the ntfy topic and the token
 * before they get here: a disabled field still hands its value to the
 * browser, and on ntfy.sh the topic alone is enough to read every message.
 * Whether a channel is set up arrives separately, as `ready`.
 */
export type NotifySettingsRow = {
  discordWebhookUrl: string;
  discordMentionRoleId: string;
  ntfyUrl: string;
  ntfyTopic: string;
  ntfyToken: string;
  webPushEnabled: boolean;
  alertDedupeMinutes: number;
};

export type NotifyRouteRow = { id: NotifyEventId; channels: NotifyChannel[] };

export function NotificationsSection({
  settings,
  ready,
  routes,
  vapidPublicKey,
  subscribedCount,
  disabled,
}: {
  settings: NotifySettingsRow;
  /** Whether each channel would send anything, worked out on the server. */
  ready: Record<NotifyChannel, boolean>;
  routes: NotifyRouteRow[];
  vapidPublicKey: string | null;
  subscribedCount: number;
  disabled: boolean;
}) {
  return (
    <>
      {/* The three channels in the order they were added and the order most
          fleets set them up: a webhook, then a phone, then the browser
          already open on this page. Each is independent — its own
          credential, its own test — so they read as three cards rather than
          one with three tabs. */}
      <DiscordCard settings={settings} ready={ready.discord} disabled={disabled} />
      <NtfyCard settings={settings} ready={ready.ntfy} disabled={disabled} />
      <WebPushCard
        settings={settings}
        ready={ready.webPush}
        disabled={disabled}
        vapidPublicKey={vapidPublicKey}
        subscribedCount={subscribedCount}
      />
      <FleetEventsCard routes={routes} ready={ready} disabled={disabled} />
      <MonitoringAlertsCard settings={settings} disabled={disabled} />
    </>
  );
}

/**
 * Which fleet event goes to which channel: one row per event, one box per
 * channel.
 *
 * A matrix rather than a channel picker per row, because the question an
 * operator arrives with is usually about a column — "what reaches my phone" —
 * and a column is something a grid answers at a glance.
 *
 * A channel that is not set up keeps its column, and its boxes stay
 * editable: routing an event to ntfy before the topic is typed is a
 * reasonable order to do things in, and the header says why nothing arrives
 * yet.
 */
function FleetEventsCard({
  routes,
  ready,
  disabled,
}: {
  routes: NotifyRouteRow[];
  ready: Record<NotifyChannel, boolean>;
  disabled: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(updateNotificationEvents, {});

  const groups = NOTIFY_EVENT_GROUPS.map((group) => ({
    group,
    rows: routes.filter((row) => NOTIFY_EVENT_META[row.id].group === group),
  })).filter(({ rows }) => rows.length > 0);

  // What is saved, as a key for the grid below. React resets a form once its
  // action lands, and a Radix checkbox resets to whatever it was *mounted*
  // with — so after a save every box flipped back to how the page first
  // loaded, and a matrix that had saved fine looked like it had reverted.
  // Keyed on the saved routes, a save that changed anything remounts the
  // boxes from the new values instead.
  const savedKey = routes.map((row) => `${row.id}:${row.channels.join("+")}`).join("|");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Megaphone className="h-4 w-4 text-muted-foreground" />
          Fleet events
        </CardTitle>
        <CardDescription>
          What the fleet tells you about itself, besides what the monitoring rules watch. Each event
          is said once, when it happens — tick where it goes.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form action={formAction} className="flex flex-col gap-4">
          {/* The events this form shows, so the action knows an event with
              every box clear is "nowhere" rather than "not on this page". */}
          <input type="hidden" name="events" value={routes.map((row) => row.id).join(",")} />

          <div key={savedKey} className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr>
                  <th
                    scope="col"
                    className="px-3 py-2 text-left text-xs font-medium text-muted-foreground"
                  >
                    Event
                  </th>
                  {CHANNEL_IDS.map((channel) => (
                    <th
                      key={channel}
                      scope="col"
                      // Narrower on a phone, where three fixed columns left
                      // the event names a word per line.
                      className="w-14 px-1 py-2 text-center text-xs font-medium text-muted-foreground sm:w-20 sm:px-2"
                    >
                      <span className="block">{CHANNEL_LABELS[channel]}</span>
                      {ready[channel] ? null : (
                        <span className="block font-normal text-muted-foreground/70">
                          not set up
                        </span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map(({ group, rows }) => (
                  <Fragment key={group}>
                    <tr className="border-t border-border">
                      <th
                        scope="colgroup"
                        colSpan={1 + CHANNEL_IDS.length}
                        className="px-3 pb-1 pt-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                      >
                        {group}
                      </th>
                    </tr>
                    {rows.map((row) => {
                      const meta = NOTIFY_EVENT_META[row.id];
                      return (
                        <tr key={row.id} className="align-top">
                          <td className="px-3 py-2">
                            <span className="block font-medium">{meta.label}</span>
                            <span className="block text-xs text-muted-foreground">{meta.hint}</span>
                          </td>
                          {CHANNEL_IDS.map((channel) => (
                            <td key={channel} className="px-1 py-2.5 text-center sm:px-2">
                              <Checkbox
                                name={`event.${row.id}`}
                                value={channel}
                                defaultChecked={row.channels.includes(channel)}
                                disabled={disabled}
                                aria-label={`${meta.label} — ${CHANNEL_LABELS[channel]}`}
                              />
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

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
 * The one notification knob that belongs to monitoring: how soon the same
 * alert may be said again. Here rather than with the rules because it decides
 * whether a message goes out, not whether a box is touched.
 */
function MonitoringAlertsCard({
  settings,
  disabled,
}: {
  settings: NotifySettingsRow;
  disabled: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(updateNotificationSettings, {});

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Binoculars className="h-4 w-4 text-muted-foreground" />
          Monitoring alerts
        </CardTitle>
        <CardDescription>
          Each rule chooses its own channels and severity, on the{" "}
          <a href="#monitoring" className="underline underline-offset-2 hover:text-foreground">
            Monitoring tab
          </a>
          . What is set here is how often the same alert may be said again.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form action={formAction} className="flex flex-col gap-4">
          <SettingGroup title="Noise">
            <NumberField
              name="alertDedupeMinutes"
              label="Repeat an alert after"
              value={settings.alertDedupeMinutes}
              min={0}
              unit="minutes"
              disabled={disabled}
              hint="The same signal on the same box is not announced again inside this. The action still happens; only the message is held. An all-clear is never held."
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
