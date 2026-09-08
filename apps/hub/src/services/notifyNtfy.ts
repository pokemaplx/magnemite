import { type MonitorLevel, type MonitorSettingsValues } from "@magnemite/db";
import { type AlertInput, alertBody, alertTitle, deviceUrl } from "./alerts.js";
import { log } from "../log.js";

/**
 * The ntfy channel.
 *
 * Published as JSON to the server root with the topic in the body rather than
 * as a plain POST to `/<topic>`: the JSON form is the only one that carries
 * the click URL, the priority and the tags in a single request, and those are
 * what make the difference between a phone buzzing usefully and buzzing.
 *
 * Anonymous by default. A public ntfy.sh topic is readable by anyone who
 * guesses it, so the docs say to pick a name nobody would — the token is for
 * a self-hosted server or a reserved topic, and empty is a valid answer.
 */

/**
 * ntfy's 1..5 dial, which decides whether a phone lights up.
 *
 * WARN is deliberately 4 rather than 3: a default-priority notification is
 * silent on a phone that is in a pocket, and a rule that fired at WARN is one
 * an operator said they wanted to hear about. CRITICAL takes 5, which bypasses
 * Do Not Disturb on Android.
 */
const LEVEL_PRIORITY: Record<MonitorLevel, number> = { INFO: 2, WARN: 4, CRITICAL: 5 };

const LEVEL_TAGS: Record<MonitorLevel, string[]> = {
  INFO: ["white_check_mark"],
  WARN: ["warning"],
  CRITICAL: ["rotating_light"],
};

export function ntfyConfigured(settings: MonitorSettingsValues): boolean {
  return Boolean(settings.ntfyUrl && settings.ntfyTopic);
}

export async function sendNtfy(
  alert: AlertInput,
  settings: MonitorSettingsValues,
): Promise<boolean> {
  if (!ntfyConfigured(settings)) return false;

  const body = {
    topic: settings.ntfyTopic,
    title: alertTitle(alert),
    // ntfy renders an empty message as the topic name, which reads like a bug.
    // A recovery with nothing else to say is the case that hits this.
    message: alertBody(alert) || alert.message,
    priority: alert.recovery ? LEVEL_PRIORITY.INFO : LEVEL_PRIORITY[alert.level],
    tags: alert.recovery ? LEVEL_TAGS.INFO : LEVEL_TAGS[alert.level],
    click: deviceUrl(alert.deviceId),
  };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.ntfyToken) headers.Authorization = `Bearer ${settings.ntfyToken}`;

  try {
    const res = await fetch(settings.ntfyUrl.replace(/\/$/, ""), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return true;

    // No retry. ntfy rate-limits by returning 429 with a Retry-After measured
    // in seconds to minutes, which is longer than the next monitor pass — so
    // waiting here would hold the pass open for an alert the next one sends
    // anyway. Discord's 429 is sub-second, which is why that one does retry.
    log.warn({ status: res.status, topic: settings.ntfyTopic }, "ntfy refused an alert");
    return false;
  } catch (err) {
    log.warn({ err }, "ntfy unreachable");
    return false;
  }
}
