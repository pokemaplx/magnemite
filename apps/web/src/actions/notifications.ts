"use server";

import { revalidatePath } from "next/cache";
import {
  NOTIFY_CHANNELS,
  NOTIFY_EVENT_IDS,
  type NotifyChannel,
  type NotifyRoutes,
  type NotifySettingsValues,
  getNotifySettings as readNotifySettings,
  prisma,
  updateNotifyRoutes as updateNotifyRoutesInDb,
  updateNotifySettings as updateNotifySettingsInDb,
} from "@magnemite/db";
import { requireOperator } from "@/lib/session";
import { hub } from "@/lib/hub";
import type { ActionState } from "./rollouts";

/**
 * Settings → Notifications: the three channels, the repeat window, and which
 * fleet event goes where.
 *
 * Its own module rather than more of `monitoring.ts`, because the channels
 * stopped being monitoring's: a rollout finishing goes out through the same
 * webhook as a box going down, and saving a webhook used to be checked
 * against the Rotom sync interval for no reason but sharing an action.
 */

/**
 * Tell the hub, best effort.
 *
 * A failure here is never an error: the values *are* saved. What it means is
 * that the hub is still sending with the old ones, which has to be said rather
 * than left to be discovered — the same convention every settings form uses.
 */
async function tellHub(): Promise<boolean> {
  try {
    await hub.refreshSettings();
    return true;
  } catch {
    return false;
  }
}

function savedMessage(told: boolean): string {
  return told
    ? "Saved."
    : "Saved, but the hub could not be told, so it is still running on the old values. Restart it, or save again once it is back.";
}

/**
 * The channel cards and the repeat window.
 *
 * Every card on the tab saves through this one action and posts only the
 * fields it shows, so a field that is absent means "this card does not own
 * it" — not empty, not off — and keeps whatever is stored. Mirroring the other
 * cards' values in hidden inputs is how saving one card used to wipe another.
 */
export async function updateNotificationSettings(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireOperator();

  const stored = await readNotifySettings();
  const submitted = (name: string) => formData.get(name) !== null;
  const text = (name: string, fallback: string) =>
    submitted(name) ? String(formData.get(name)).trim() : fallback;

  // The shape is checked only when it was typed. A stored value that predates
  // this rule must not block a save from a card that never shows the webhook.
  const webhook = text("discordWebhookUrl", stored.discordWebhookUrl);
  if (
    submitted("discordWebhookUrl") &&
    webhook &&
    !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(webhook)
  ) {
    return {
      error:
        "That does not look like a Discord webhook. Copy it from the channel's Integrations settings — it starts with https://discord.com/api/webhooks/.",
    };
  }

  // ntfy. The topic is what decides whether the channel is on, so a server
  // URL alone is not an error -- it is the default sitting there unused.
  const ntfyUrl = text("ntfyUrl", stored.ntfyUrl);
  if (submitted("ntfyUrl") && ntfyUrl && !/^https?:\/\//.test(ntfyUrl)) {
    return {
      error:
        "The ntfy server needs to be a URL, starting with https:// — or http:// for one on your own network.",
    };
  }

  const ntfyTopic = text("ntfyTopic", stored.ntfyTopic);
  // ntfy's own rule for a topic, and worth enforcing here rather than
  // discovering as a 400 during an incident: a slash would silently address a
  // different path on the server entirely.
  if (submitted("ntfyTopic") && ntfyTopic && !/^[A-Za-z0-9_-]{1,64}$/.test(ntfyTopic)) {
    return {
      error:
        "An ntfy topic is letters, digits, dashes and underscores — no slashes, and no spaces. Put the server in the field beside it.",
    };
  }
  if (ntfyTopic && !ntfyUrl) {
    return { error: "A topic needs a server. https://ntfy.sh is the public one." };
  }

  let alertDedupeMinutes = stored.alertDedupeMinutes;
  if (submitted("alertDedupeMinutes")) {
    const parsed = Number(formData.get("alertDedupeMinutes"));
    if (!Number.isFinite(parsed) || parsed < 0) {
      return { error: "The repeat window is a whole number of minutes, 0 or more." };
    }
    alertDedupeMinutes = Math.floor(parsed);
  }

  const patch: NotifySettingsValues = {
    discordWebhookUrl: webhook,
    discordMentionRoleId: text("discordMentionRoleId", stored.discordMentionRoleId),
    ntfyUrl,
    ntfyTopic,
    ntfyToken: text("ntfyToken", stored.ntfyToken),
    // Posted by the web push card as an explicit "on"/"off" rather than left
    // to an unchecked switch, which posts nothing and would be
    // indistinguishable from a save that came from another card.
    webPushEnabled: submitted("webPushEnabled")
      ? formData.get("webPushEnabled") === "on"
      : stored.webPushEnabled,
    alertDedupeMinutes,
  };
  await updateNotifySettingsInDb(patch);

  const told = await tellHub();
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "settings.notifications",
      // Credentials are recorded as changed, not as what they changed to:
      // anyone holding the webhook can post to the channel, and on ntfy.sh the
      // topic itself is what lets somebody read every message.
      meta: {
        ...patch,
        discordWebhookUrl: patch.discordWebhookUrl ? "set" : "",
        ntfyTopic: patch.ntfyTopic ? "set" : "",
        ntfyToken: patch.ntfyToken ? "set" : "",
        hubNotified: told,
      },
    },
  });

  revalidatePath("/settings");
  return { ok: true, message: savedMessage(told) };
}

/**
 * Which channels each fleet event goes to.
 *
 * Each event's boxes post its channels under one name, and an event with
 * every box clear posts nothing at all — so what to update comes from the
 * `events` list the form rendered, not from what arrived. That list is also
 * what keeps a page loaded before an upgrade from switching off an event it
 * never showed.
 */
export async function updateNotificationEvents(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireOperator();

  const rendered = new Set(String(formData.get("events") ?? "").split(","));
  const patch: Partial<NotifyRoutes> = {};
  for (const id of NOTIFY_EVENT_IDS) {
    if (!rendered.has(id)) continue;
    const chosen = new Set(formData.getAll(`event.${id}`).map(String));
    // In the channels' own order, and only ones that exist: anything else
    // could only come from a newer page against an older server.
    patch[id] = NOTIFY_CHANNELS.filter((channel) => chosen.has(channel));
  }
  if (Object.keys(patch).length === 0) {
    return { error: "Nothing to save. Reload the page and try again." };
  }
  await updateNotifyRoutesInDb(patch);

  const told = await tellHub();
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      userEmail: user.email,
      action: "settings.notifications.events",
      meta: { ...patch, hubNotified: told },
    },
  });

  revalidatePath("/settings");
  return { ok: true, message: savedMessage(told) };
}

/**
 * Prove one channel, so nobody finds out it was wrong during an incident.
 *
 * Only the channel whose card the button is on — a test that went to all
 * three meant a phone buzzing for somebody fixing a webhook.
 */
export async function sendTestNotification(channel: NotifyChannel): Promise<ActionState> {
  await requireOperator();
  if (!(NOTIFY_CHANNELS as readonly string[]).includes(channel)) {
    return { error: "That is not a channel." };
  }
  try {
    const result = await hub.testNotification(channel);
    if (!result.ok) return { error: result.error ?? "Nothing accepted the message." };
    return { ok: true, message: "Sent — it should arrive in a few seconds." };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
