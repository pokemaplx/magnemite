import { type MonitorSettingsValues } from "@magnemite/db";
import { type AlertInput, LEVEL_ICON, clamp, deviceUrl } from "./alerts.js";
import { log } from "../log.js";

/**
 * The Discord channel.
 *
 * Was the whole of `notify.ts` until ntfy and web push joined it. What stayed
 * behind here is everything Discord-shaped: the embed, its colours, and the
 * 429 handshake — none of which the other two have an equivalent for.
 */

/** Discord's embed colours, as the integers its API wants. */
const LEVEL_COLOUR: Record<string, number> = {
  INFO: 0x3b_82_f6,
  WARN: 0xf5_9e_0b,
  CRITICAL: 0xef_44_44,
};

export function discordConfigured(settings: MonitorSettingsValues): boolean {
  return Boolean(settings.discordWebhookUrl);
}

export async function sendDiscord(
  alert: AlertInput,
  settings: MonitorSettingsValues,
): Promise<boolean> {
  if (!settings.discordWebhookUrl) return false;
  return post(settings.discordWebhookUrl, buildPayload(alert, settings.discordMentionRoleId));
}

export function buildPayload(alert: AlertInput, mentionRoleId: string): unknown {
  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: "Device", value: `[${alert.deviceName}](${deviceUrl(alert.deviceId)})`, inline: true },
    { name: "Group", value: alert.groupName ?? "—", inline: true },
  ];

  if (alert.action && alert.action !== "NOTIFY_ONLY") {
    fields.push({
      name: "Action",
      // Whether it worked is the second half of the sentence, and the half an
      // operator is actually deciding on: a failed restart needs a person.
      value: `${alert.action}${alert.actionOk === null ? "" : alert.actionOk ? " ✓" : " ✗ failed"}`,
      inline: true,
    });
  }
  if (alert.detail) {
    // Fenced, because a detail is usually a line of log or command output and
    // Discord would otherwise render its punctuation as markdown.
    fields.push({ name: "Detail", value: `\`\`\`\n${clamp(alert.detail, 900)}\n\`\`\`` });
  }

  return {
    // Only CRITICAL pings. A role mention on every warning is how a channel
    // gets muted, which costs the alert that mattered.
    content: mentionRoleId && alert.level === "CRITICAL" ? `<@&${mentionRoleId}>` : undefined,
    embeds: [
      {
        title: `${LEVEL_ICON[alert.level]} ${alert.deviceName} — ${alert.message}`,
        color: LEVEL_COLOUR[alert.level],
        fields,
        footer: { text: `Magnemite · ${alert.signal}` },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

async function post(webhookUrl: string, payload: unknown): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return true;

      // Discord says exactly how long to wait, and a fleet that just came back
      // from a deploy can hit this legitimately. One retry, then give up —
      // there is another beat along shortly.
      if (res.status === 429 && attempt === 0) {
        const body = (await res.json().catch(() => null)) as { retry_after?: number } | null;
        const waitMs = Math.min((body?.retry_after ?? 1) * 1000, 5_000);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      log.warn({ status: res.status }, "discord webhook refused an alert");
      return false;
    } catch (err) {
      log.warn({ err }, "discord webhook unreachable");
      return false;
    }
  }
  return false;
}
