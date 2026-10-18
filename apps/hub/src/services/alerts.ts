import { type MonitorLevel, type MonitorSignal, type NotifyChannel } from "@magnemite/db";
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
  channels: NotifyChannel[];
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

export type NoticeField = { name: string; value: string; inline?: boolean };

/**
 * One message, in the shape every channel can send.
 *
 * A monitor alert is one source of these and the fleet events are the other,
 * which is why the channels take this rather than an alert: a rollout that
 * finished has no device, no signal and no action, and teaching each channel
 * about every kind of event is the drift this file exists to prevent. The
 * builder decides what is said; the channel only decides how it looks.
 */
export type Notice = {
  level: MonitorLevel;
  /** In front of the title instead of the level's own icon. */
  icon?: string;
  /** One line: what happened, to what. Without the icon — that is added here. */
  title: string;
  /**
   * The plain-text body, for ntfy and web push. A phone notification is read
   * from the top and often only its first line, so the builder puts what an
   * operator decides on first and the raw detail last.
   */
  body: string;
  /**
   * The same facts as Discord fields. Absent, Discord shows `body` as the
   * description instead.
   */
  fields?: NoticeField[];
  /**
   * Raw output, fenced in a field of its own on Discord. The text channels
   * already have it at the end of `body`.
   */
  detail?: string | null;
  /** The dashboard page this is about, e.g. `/rollouts/abc`. */
  path: string;
  /**
   * Two notices with the same tag replace each other in a browser's tray
   * rather than stacking — a rollout that started and then finished is one
   * notification, not two.
   */
  tag: string;
  /** After "Magnemite ·" in Discord's footer. */
  footer: string;
  /**
   * Good news: an all-clear or a success. Sent at the lowest priority, so a
   * phone shows it without lighting up and a browser shows it silently.
   */
  quiet?: boolean;
};

/**
 * A link to a dashboard page, so a message is one click from doing something.
 *
 * Built on the dashboard's origin -- not `MAGNEMITE_PUBLIC_URL`, which is the
 * address the *boxes* use. Where the two are separate hosts (Coolify) that
 * domain is Caddy, which answers `/files/*`, `/ws/device`, `/api/enroll` and
 * `/healthz` and 404s the rest. The fallback is for the single-domain
 * deployments, where they are the same.
 */
export function dashboardUrl(path: string): string {
  const base = env.MAGNEMITE_DASHBOARD_URL ?? env.MAGNEMITE_PUBLIC_URL;
  return `${base.replace(/\/$/, "")}${path}`;
}

/** The link back to the box. */
export function deviceUrl(deviceId: string): string {
  return dashboardUrl(`/devices/${deviceId}`);
}

export function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** The title as every channel shows it: the icon, then the line. */
export function noticeTitle(notice: Notice): string {
  return `${notice.icon ?? LEVEL_ICON[notice.level]} ${notice.title}`;
}

/** Whether an action worked — the half of the sentence an operator decides on. */
function outcome(actionOk: boolean | null): string {
  return actionOk === null ? "" : actionOk ? " ✓" : " ✗ failed";
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
    lines.push(`Action: ${alert.action}${outcome(alert.actionOk)}`);
  }
  if (alert.detail) lines.push(clamp(alert.detail, 400));
  return lines.join("\n");
}

/**
 * A monitor alert as a notice, looking exactly the way alerts always have:
 * the box linked, its group, what was done about it, and the detail fenced.
 */
export function toNotice(alert: AlertInput): Notice {
  const fields: NoticeField[] = [
    { name: "Device", value: `[${alert.deviceName}](${deviceUrl(alert.deviceId)})`, inline: true },
    { name: "Group", value: alert.groupName ?? "—", inline: true },
  ];
  if (alert.action && alert.action !== "NOTIFY_ONLY") {
    fields.push({
      name: "Action",
      value: `${alert.action}${outcome(alert.actionOk)}`,
      inline: true,
    });
  }

  return {
    level: alert.level,
    title: `${alert.deviceName} — ${alert.message}`,
    // ntfy renders an empty message as the topic name, which reads like a bug.
    // A recovery with nothing else to say is the case that hits this.
    body: alertBody(alert) || alert.message,
    fields,
    detail: alert.detail,
    path: `/devices/${alert.deviceId}`,
    // Two alerts about the same box and the same signal replace each other in
    // the tray rather than stacking. A box that flaps would otherwise bury
    // everything else under a column of itself.
    tag: `${alert.deviceId}:${alert.signal}`,
    footer: alert.signal,
    // A fault gets to interrupt; an all-clear does not.
    quiet: alert.recovery,
  };
}
