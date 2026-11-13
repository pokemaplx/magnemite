import {
  type MonitorSignal,
  NOTIFY_CHANNELS,
  type NotifyChannel,
  type NotifyEventId,
  type NotifySettingsValues,
  prisma,
} from "@magnemite/db";
import { getNotifyRoutes, getNotifySettings } from "./hubSettings.js";
import { type AlertInput, type Notice, toNotice } from "./alerts.js";
import { discordConfigured, sendDiscord } from "./notifyDiscord.js";
import { ntfyConfigured, sendNtfy } from "./notifyNtfy.js";
import { sendWebPush, webPushAvailable, webPushConfigured } from "./notifyWebPush.js";
import { log } from "../log.js";

export type { AlertInput, Notice } from "./alerts.js";

/**
 * Outbound notifications, and which of the three channels each one goes to.
 *
 * Two things announce. The monitor does, about a box gone wrong, and decides
 * per rule where it goes. The fleet does, about rollouts, builds and machines
 * (`fleetEvents.ts`), and Settings → Notifications decides per event where
 * that goes. Both end up in `deliver` below.
 *
 * The rule this file exists to enforce is that **notifying never breaks the
 * thing it is about**. A Discord outage, a revoked webhook, an ntfy rate
 * limit, a push service having a bad afternoon — none of those are reasons to
 * stop restarting a dead scanner or to fail a rollout, so nothing here throws
 * into its caller and every failure is a log line. For a monitor alert it is
 * also a `notified: false` on the event that was supposed to go out, so a
 * silent hour has an explanation sitting in the events table rather than
 * being a mystery.
 *
 * The three channels are independent in every way that matters: each is
 * configured on its own, and one of them being broken says nothing about the
 * other two.
 *
 * **Which channels a message goes to is its source's answer, not this
 * file's.** Each channel used to carry a minimum severity of its own, and two
 * filters in series meant a rule that said "ntfy" could silently not reach
 * ntfy, with nothing on the rule to explain it. What is left here is one
 * question per channel — is it set up — asked of a list already chosen.
 */

type Channel = {
  /** Matches what rules and event routes store. Frozen. */
  id: NotifyChannel;
  /** What an operator reads in a test result or a log line. Not frozen. */
  label: string;
  configured: (settings: NotifySettingsValues) => boolean;
  send: (notice: Notice, settings: NotifySettingsValues) => Promise<boolean>;
};

const CHANNELS: Channel[] = [
  { id: "discord", label: "Discord", configured: discordConfigured, send: sendDiscord },
  { id: "ntfy", label: "ntfy", configured: ntfyConfigured, send: sendNtfy },
  { id: "webPush", label: "web push", configured: webPushConfigured, send: sendWebPush },
];

/** The channels in this list that are actually set up. */
function willing(channels: readonly NotifyChannel[], settings: NotifySettingsValues): Channel[] {
  return CHANNELS.filter(
    (channel) => channels.includes(channel.id) && channel.configured(settings),
  );
}

/**
 * Send one notice to the given channels, and say which took it.
 *
 * In parallel, and never rejecting: one channel throwing must not cost the
 * others their message, and none of it may reach the caller.
 */
async function deliver(
  notice: Notice,
  channels: Channel[],
  settings: NotifySettingsValues,
): Promise<{ label: string; ok: boolean }[]> {
  return Promise.all(
    channels.map(async (channel) => {
      try {
        return { label: channel.label, ok: await channel.send(notice, settings) };
      } catch (err) {
        log.warn({ err, channel: channel.id }, "notification channel threw");
        return { label: channel.label, ok: false };
      }
    }),
  );
}

/**
 * Has this box already been announced for this signal recently?
 *
 * Read off the events table rather than an in-memory map on purpose: the
 * dedupe window outlives a hub restart, and a deploy is exactly the moment a
 * fleet reconnects at once and would otherwise announce everything twice.
 */
async function announcedRecently(
  deviceId: string,
  signal: MonitorSignal,
  minutes: number,
): Promise<boolean> {
  if (minutes <= 0) return false;

  const since = new Date(Date.now() - minutes * 60_000);
  const previous = await prisma.monitorEvent.findFirst({
    // Recoveries are excluded on purpose: an all-clear is not what a fault is
    // being deduped against, and it must not silence the next fault either.
    where: { deviceId, signal, notified: true, recovery: false, at: { gte: since } },
    select: { id: true },
  });
  return previous !== null;
}

/**
 * Send one monitor alert, and say whether it went anywhere.
 *
 * The return value is what the caller stores as `notified`, so "the rule asked
 * for no channels", "the ones it asked for are not set up" and "all of them
 * refused it" all come back as false — the difference is in the log, and in what an
 * operator finds when they go looking at Settings → Notifications. True means at
 * least one channel took it, which is the honest reading of "this was
 * announced": a Discord message that landed is not made un-sent by ntfy being
 * down at the same moment.
 */
export async function notify(alert: AlertInput): Promise<boolean> {
  const settings = await getNotifySettings();

  // Which channels the rule asked for and are actually set up. Computed
  // before the dedupe check so an alert nobody would have sent does not
  // consume the window, the same order the single-channel version used.
  const channels = willing(alert.channels, settings);
  if (channels.length === 0) return false;

  if (!alert.recovery) {
    if (await announcedRecently(alert.deviceId, alert.signal, settings.alertDedupeMinutes)) {
      log.debug({ device: alert.deviceName, signal: alert.signal }, "alert deduped");
      return false;
    }
  }

  const results = await deliver(toNotice(alert), channels, settings);
  return results.some((result) => result.ok);
}

/**
 * Announce a fleet event, on whichever channels Settings routes it to.
 *
 * The notice is built lazily, and only once something would send it: most of
 * what an event says takes a query or two — the boxes that failed, who
 * started the rollout — and a fleet with no channel set up, or with this
 * event switched off, should pay nothing for being asked. A builder that
 * returns null has decided there is nothing worth saying after all.
 *
 * Never rejects. Callers fire it with `void` from the middle of the work it
 * is about — a job finishing, a poll — and a notification is never a reason
 * for that work to fail.
 */
export async function announce(
  event: NotifyEventId,
  build: () => Notice | null | Promise<Notice | null>,
): Promise<void> {
  try {
    const [settings, routes] = await Promise.all([getNotifySettings(), getNotifyRoutes()]);
    const channels = willing(routes[event], settings);
    if (channels.length === 0) return;

    const notice = await build();
    if (!notice) return;

    const results = await deliver(notice, channels, settings);
    const delivered = results.filter((result) => result.ok).map((result) => result.label);
    log.info({ event, title: notice.title, delivered }, "fleet event announced");
  } catch (err) {
    log.warn({ err, event }, "could not announce a fleet event");
  }
}

/**
 * Prove a channel before anyone trusts it.
 *
 * Deliberately bypasses routing and the dedupe window: someone pressing a
 * button called "Send test" wants to see a message, not to discover thirty
 * minutes later that one was suppressed. Uses what is saved, not what is
 * typed in the card, because the saved value is what everything else sends
 * with.
 *
 * With a channel, tests that one — the button is on that channel's card, and
 * a test that fanned out to all three meant a phone buzzing for someone
 * fixing a webhook. Without one, every channel that is set up, reporting per
 * channel, because "it worked" is useless when the question is which of three
 * is misconfigured.
 */
export async function sendTestNotification(channel?: NotifyChannel): Promise<{
  ok: boolean;
  error: string | null;
  detail: string | null;
}> {
  const settings = await getNotifySettings();

  const asked = channel ? [channel] : [...NOTIFY_CHANNELS];
  const configured = willing(asked, settings);
  if (configured.length === 0) {
    return { ok: false, error: notSetUp(channel), detail: null };
  }

  const notice: Notice = {
    level: "INFO",
    icon: "🔔",
    title: "Test notification — this channel is wired up",
    body: "This is what Magnemite's notifications will look like here.",
    path: "/settings#notifications",
    tag: "magnemite:test",
    footer: "test",
  };

  const results = await deliver(notice, configured, settings);
  const detail = results.map((r) => `${r.label} ${r.ok ? "✓" : "✗"}`).join(" · ");

  if (results.every((r) => !r.ok)) {
    return {
      ok: false,
      error: channel
        ? `${configured[0]?.label ?? channel} did not accept the message. ${refusedHint(channel)}`
        : `Nothing accepted the message (${detail}). Check the webhook URL, the ntfy topic, and whether any browser is subscribed.`,
      detail,
    };
  }
  return { ok: true, error: null, detail };
}

function notSetUp(channel: NotifyChannel | undefined): string {
  switch (channel) {
    case "discord":
      return "Discord is not set up. Save a webhook URL first.";
    case "ntfy":
      return "ntfy is not set up. Save a server and a topic first.";
    case "webPush":
      return webPushAvailable()
        ? "Web push is switched off. Turn it on and save first."
        : "Web push needs VAPID keys in the hub's environment before it can be turned on.";
    default:
      return webPushAvailable()
        ? "No channel is set up. Add a Discord webhook, an ntfy topic, or turn web push on."
        : "No channel is set up. Add a Discord webhook or an ntfy topic — web push also needs VAPID keys in the hub's environment.";
  }
}

function refusedHint(channel: NotifyChannel): string {
  switch (channel) {
    case "discord":
      return "Check the webhook URL — a deleted webhook answers 404.";
    case "ntfy":
      return "Check the server, the topic and the token.";
    case "webPush":
      return "No subscribed browser took it. Subscribe this browser below, then try again.";
  }
}
