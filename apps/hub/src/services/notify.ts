import { MONITOR_CHANNELS, type MonitorChannel, type MonitorSignal, prisma } from "@magnemite/db";
import { getMonitorSettings } from "./hubSettings.js";
import { type AlertInput } from "./alerts.js";
import { discordConfigured, sendDiscord } from "./notifyDiscord.js";
import { ntfyConfigured, sendNtfy } from "./notifyNtfy.js";
import { sendWebPush, webPushAvailable, webPushConfigured } from "./notifyWebPush.js";
import { log } from "../log.js";

export type { AlertInput } from "./alerts.js";

/**
 * Outbound alerts, and which of the three channels each one goes to.
 *
 * The rule this file exists to enforce is that **notifying never breaks
 * remediation**. A Discord outage, a revoked webhook, an ntfy rate limit, a
 * push service having a bad afternoon — none of those are reasons to stop
 * restarting a dead scanner, so nothing here throws into the engine and every
 * failure is a log line and a `notified: false` on the event that was supposed
 * to go out. A silent hour then has an explanation sitting in the events table
 * rather than being a mystery.
 *
 * The three channels are independent in every way that matters: each is
 * configured on its own, and one of them being broken says nothing about the
 * other two. What they share is the dedupe window, which is deliberately
 * global — the point of it is that a flapping box does not announce itself
 * thirty times, and per-channel windows would let it do exactly that by
 * taking turns.
 *
 * **Which channels an alert goes to is the rule's answer, not this file's.**
 * Each channel used to carry a minimum severity of its own, and two filters
 * in series meant a rule that said "ntfy" could silently not reach ntfy, with
 * nothing on the rule to explain it. What is left here is one question per
 * channel — is it set up — asked of a list the rule already chose.
 */

type Settings = Awaited<ReturnType<typeof getMonitorSettings>>;

type Channel = {
  /** Matches what a rule stores in `notifyChannels`. Frozen. */
  id: MonitorChannel;
  /** What an operator reads in a test result or a log line. Not frozen. */
  label: string;
  configured: (settings: Settings) => boolean;
  send: (alert: AlertInput, settings: Settings) => Promise<boolean>;
};

const CHANNELS: Channel[] = [
  { id: "discord", label: "Discord", configured: discordConfigured, send: sendDiscord },
  { id: "ntfy", label: "ntfy", configured: ntfyConfigured, send: sendNtfy },
  { id: "webPush", label: "web push", configured: webPushConfigured, send: sendWebPush },
];

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
 * Send one alert, and say whether it went anywhere.
 *
 * The return value is what the caller stores as `notified`, so "the rule asked
 * for no channels", "the ones it asked for are not set up" and "all of them
 * refused it" all come back as false — the difference is in the log, and in what an
 * operator finds when they go looking at Settings → Monitoring. True means at
 * least one channel took it, which is the honest reading of "this was
 * announced": a Discord message that landed is not made un-sent by ntfy being
 * down at the same moment.
 */
export async function notify(alert: AlertInput): Promise<boolean> {
  const settings = await getMonitorSettings();

  // Which channels the rule asked for and are actually set up. Computed
  // before the dedupe check so an alert nobody would have sent does not
  // consume the window, the same order the single-channel version used.
  const willing = CHANNELS.filter(
    (channel) => alert.channels.includes(channel.id) && channel.configured(settings),
  );
  if (willing.length === 0) return false;

  if (!alert.recovery) {
    if (await announcedRecently(alert.deviceId, alert.signal, settings.alertDedupeMinutes)) {
      log.debug({ device: alert.deviceName, signal: alert.signal }, "alert deduped");
      return false;
    }
  }

  // In parallel, and never rejecting: one channel throwing must not cost the
  // others their message, and none of it may reach the engine.
  const results = await Promise.all(
    willing.map(async (channel) => {
      try {
        return await channel.send(alert, settings);
      } catch (err) {
        log.warn({ err, channel: channel.id }, "notification channel threw");
        return false;
      }
    }),
  );

  return results.some(Boolean);
}

/**
 * Prove the channels before anyone trusts them.
 *
 * Deliberately bypasses the level filter and the dedupe window: someone
 * pressing a button called "Send test alert" wants to see a message, not to
 * discover thirty minutes later that one was suppressed. It reports per
 * channel rather than as one yes/no, because "it worked" is useless when the
 * question is which of three is misconfigured.
 */
export async function sendTestAlert(): Promise<{
  ok: boolean;
  error: string | null;
  detail: string | null;
}> {
  const settings = await getMonitorSettings();

  const configured = CHANNELS.filter((channel) => channel.configured(settings));
  if (configured.length === 0) {
    return {
      ok: false,
      error: webPushAvailable()
        ? "No channel is set up. Add a Discord webhook, an ntfy topic, or turn web push on."
        : "No channel is set up. Add a Discord webhook or an ntfy topic — web push also needs VAPID keys in the hub's environment.",
      detail: null,
    };
  }

  const alert: AlertInput = {
    deviceId: "test",
    // No rule behind a test, so every configured channel is the answer —
    // `configured` above has already narrowed it to those.
    channels: [...MONITOR_CHANNELS],
    deviceName: "Test alert",
    groupName: null,
    signal: "AGENT_OFFLINE",
    level: "INFO",
    message: "monitoring is wired up",
    action: null,
    actionOk: null,
    detail: "This is what a real alert will look like.",
    recovery: false,
  };

  const results = await Promise.all(
    configured.map(async (channel) => {
      try {
        return { label: channel.label, ok: await channel.send(alert, settings) };
      } catch (err) {
        log.warn({ err, channel: channel.id }, "notification channel threw on a test");
        return { label: channel.label, ok: false };
      }
    }),
  );

  const detail = results.map((r) => `${r.label} ${r.ok ? "✓" : "✗"}`).join(" · ");
  const failed = results.filter((r) => !r.ok);

  if (failed.length === results.length) {
    return {
      ok: false,
      error: `Nothing accepted the message (${detail}). Check the webhook URL, the ntfy topic, and whether any browser is subscribed.`,
      detail,
    };
  }
  return { ok: true, error: null, detail };
}
