import { type MonitorLevel, type NotifySettingsValues } from "@magnemite/db";
import { type Notice, dashboardUrl, noticeTitle } from "./alerts.js";
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

export function ntfyConfigured(settings: NotifySettingsValues): boolean {
  return Boolean(settings.ntfyUrl && settings.ntfyTopic);
}

export async function sendNtfy(notice: Notice, settings: NotifySettingsValues): Promise<boolean> {
  if (!ntfyConfigured(settings)) return false;

  const level = notice.quiet ? "INFO" : notice.level;
  const body = {
    topic: settings.ntfyTopic,
    title: noticeTitle(notice),
    message: notice.body,
    priority: LEVEL_PRIORITY[level],
    // ntfy turns a tag that names an emoji into that emoji in front of the
    // title. A notice that brings its own icon already has one there, and two
    // in a row reads as a glitch.
    tags: notice.icon ? [] : LEVEL_TAGS[level],
    click: dashboardUrl(notice.path),
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
    log.warn({ status: res.status, topic: settings.ntfyTopic }, "ntfy refused a notification");
    return false;
  } catch (err) {
    log.warn({ err }, "ntfy unreachable");
    return false;
  }
}
