import { type MonitorChannel, type MonitorLevel, type MonitorSignal } from "@magnemite/db";
import { env } from "../env.js";

/**
 * What every notification channel needs, and nothing about how any of them
 * sends it.
 *
 * Split out of `notify.ts` when the second and third channels arrived: the
 * level ladder, the wording and the link back to the box are the same
 * question whether the answer goes to Discord, to a phone or to a browser,
 * and having each channel answer it again is how they drift apart.
 */

export const LEVEL_ICON: Record<MonitorLevel, string> = {
  INFO: "✅",
  WARN: "⚠️",
  CRITICAL: "🔴",
};

export type AlertInput = {
  deviceId: string;
  /**
   * Which channels this alert is for, off the rule that raised it.
   *
   * The only filter there is. Each channel used to carry a minimum severity
   * as well, and two filters in series meant a rule that said "ntfy" could
   * silently not reach ntfy — with nothing on the rule to explain it. The
   * severity below still travels, but only to decide how the alert *looks*.
   */
  channels: MonitorChannel[];
  deviceName: string;
  groupName: string | null;
  signal: MonitorSignal;
  level: MonitorLevel;
  message: string;
  action: string | null;
  actionOk: boolean | null;
  detail: string | null;
  /**
   * The all-clear rather than a fault, which changes two things: it goes out
   * regardless of the minimum level — a recovery is INFO by nature, and an
   * operator who asked for one on the rule did not ask for it to be weighed
   * against a floor of WARN — and it ignores the dedupe window, which was
   * very likely just filled by the fault this ends.
   */
  recovery: boolean;
};

/**
 * The link back to the box, so an alert is one click from doing something.
 *
 * `/devices/:id` is a dashboard page, so it is built on the dashboard's origin
 * -- not `MAGNEMITE_PUBLIC_URL`, which is the address the *boxes* use. Where
 * the two are separate hosts (Coolify) that domain is Caddy, which answers
 * `/files/*`, `/ws/device`, `/api/enroll` and `/healthz` and 404s the rest.
 * The fallback is for the single-domain deployments, where they are the same.
 */
export function deviceUrl(deviceId: string): string {
  const base = env.MAGNEMITE_DASHBOARD_URL ?? env.MAGNEMITE_PUBLIC_URL;
  return `${base.replace(/\/$/, "")}/devices/${deviceId}`;
}

export function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** One line, the same one everywhere: what happened, on what, in what group. */
export function alertTitle(alert: AlertInput): string {
  return `${LEVEL_ICON[alert.level]} ${alert.deviceName} — ${alert.message}`;
}

/**
 * The body for the channels that take plain text rather than a structure.
 *
 * Discord builds fields out of the same facts instead, because it can. What
 * is deliberate here is the order: group, then what was done about it, then
 * the raw detail last — a phone notification is read from the top and often
 * only the first line of it.
 */
export function alertBody(alert: AlertInput): string {
  const lines: string[] = [];
  if (alert.groupName) lines.push(`Group: ${alert.groupName}`);
  if (alert.action && alert.action !== "NOTIFY_ONLY") {
    // Whether it worked is the second half of the sentence, and the half an
    // operator is actually deciding on: a failed restart needs a person.
    const outcome = alert.actionOk === null ? "" : alert.actionOk ? " ✓" : " ✗ failed";
    lines.push(`Action: ${alert.action}${outcome}`);
  }
  if (alert.detail) lines.push(clamp(alert.detail, 400));
  return lines.join("\n");
}
