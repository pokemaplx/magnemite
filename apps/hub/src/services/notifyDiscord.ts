import { type NotifySettingsValues } from "@magnemite/db";
import { type Notice, clamp, dashboardUrl, noticeTitle } from "./alerts.js";
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

/**
 * Discord's own ceilings. Past any of them the whole message is refused with
 * a 400, so a long error is cut here rather than costing the notification.
 */
const TITLE_MAX = 256;
const FIELD_MAX = 1024;
const DESCRIPTION_MAX = 4096;

export function discordConfigured(settings: NotifySettingsValues): boolean {
  return Boolean(settings.discordWebhookUrl);
}

export async function sendDiscord(
  notice: Notice,
  settings: NotifySettingsValues,
): Promise<boolean> {
  if (!settings.discordWebhookUrl) return false;
  return post(settings.discordWebhookUrl, buildPayload(notice, settings.discordMentionRoleId));
}

export function buildPayload(notice: Notice, mentionRoleId: string): unknown {
  const fields = (notice.fields ?? []).map((field) => ({
    ...field,
    // An empty value is a 400 for the whole message, not a blank field.
    value: clamp(field.value || "—", FIELD_MAX),
  }));
  // Fields when the builder had facts to set out, the plain body when it did
  // not — never both, which would say everything twice. The body already ends
  // with the detail, so the fenced copy below is only for the fields layout.
  const description = fields.length === 0 ? clamp(notice.body, DESCRIPTION_MAX) : undefined;
  if (notice.detail && fields.length > 0) {
    // Fenced, because a detail is usually a line of log or command output and
    // Discord would otherwise render its punctuation as markdown.
    fields.push({ name: "Detail", value: `\`\`\`\n${clamp(notice.detail, 900)}\n\`\`\`` });
  }

  return {
    // Only CRITICAL pings. A role mention on every warning is how a channel
    // gets muted, which costs the alert that mattered.
    content: mentionRoleId && notice.level === "CRITICAL" ? `<@&${mentionRoleId}>` : undefined,
    embeds: [
      {
        title: clamp(noticeTitle(notice), TITLE_MAX),
        // The title itself is the link, so a message is one click from the
        // page it is about whatever its fields say.
        url: dashboardUrl(notice.path),
        description,
        color: LEVEL_COLOUR[notice.level],
        fields,
        footer: { text: `Magnemite · ${notice.footer}` },
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

      log.warn({ status: res.status }, "discord webhook refused a notification");
      return false;
    } catch (err) {
      log.warn({ err }, "discord webhook unreachable");
      return false;
    }
  }
  return false;
}
