import { createHash } from "node:crypto";
import { type MonitorSettingsValues, prisma } from "@magnemite/db";
import webpush, { WebPushError } from "web-push";
import { type AlertInput, alertBody, alertTitle, deviceUrl } from "./alerts.js";
import { env } from "../env.js";
import { log } from "../log.js";

/**
 * The web push channel: a notification on the desktop or phone of whoever
 * subscribed in the dashboard.
 *
 * Unlike the other two there is no URL an operator can paste in. A push
 * service will only accept a message signed by the VAPID key it saw at
 * subscription time, so the keypair is deployment identity and lives in the
 * environment — and regenerating it silently invalidates every subscription
 * already out there, which is precisely why it is not a button in a form.
 *
 * The other asymmetry is cleanup. Nothing tells us a browser was uninstalled,
 * cleared or revoked; the push service simply answers 404 or 410 the next
 * time. Deleting the row on that answer is the only garbage collection there
 * is, so it is not optional — without it a fleet accumulates dead endpoints
 * and every alert pays for them.
 */

let configured = false;

/** Are the VAPID keys present at all? Independent of the on/off setting. */
export function webPushAvailable(): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

export function webPushConfigured(settings: MonitorSettingsValues): boolean {
  return settings.webPushEnabled && webPushAvailable();
}

/** sha256 of the endpoint, hex — the key rows are stored and found under. */
export function hashEndpoint(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

function ensureConfigured(): boolean {
  if (configured) return true;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

export async function sendWebPush(
  alert: AlertInput,
  settings: MonitorSettingsValues,
): Promise<boolean> {
  if (!webPushConfigured(settings) || !ensureConfigured()) return false;

  const subscriptions = await prisma.pushSubscription.findMany({
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  if (subscriptions.length === 0) return false;

  const payload = JSON.stringify({
    title: alertTitle(alert),
    body: alertBody(alert) || alert.message,
    url: deviceUrl(alert.deviceId),
    // Two alerts about the same box and the same signal replace each other in
    // the tray rather than stacking. A box that flaps would otherwise bury
    // everything else under a column of itself.
    tag: `${alert.deviceId}:${alert.signal}`,
    level: alert.level,
    // A fault gets to interrupt; an all-clear does not. Notifications the
    // operating system shows silently are the reason recoveries are worth
    // having on at all.
    silent: alert.recovery,
  });

  const dead: string[] = [];
  const results = await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          payload,
          { TTL: 3600 },
        );
        return subscription.id;
      } catch (err) {
        // 404 and 410 are the push service saying this endpoint is gone for
        // good. Anything else — a timeout, a 5xx, a rate limit — is this
        // moment only, and deleting on it would unsubscribe a browser that is
        // fine.
        if (err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
          dead.push(subscription.id);
        } else {
          log.warn({ err }, "web push endpoint refused an alert");
        }
        return null;
      }
    }),
  );

  const sent = results.filter((id): id is string => id !== null);
  if (sent.length > 0) {
    await prisma.pushSubscription.updateMany({
      where: { id: { in: sent } },
      data: { lastSentAt: new Date() },
    });
  }
  if (dead.length > 0) {
    await prisma.pushSubscription.deleteMany({ where: { id: { in: dead } } });
    log.info({ count: dead.length }, "dropped push subscriptions the service says are gone");
  }

  return sent.length > 0;
}

/** How many browsers are subscribed, for the dashboard to show. */
export async function countPushSubscriptions(): Promise<number> {
  return prisma.pushSubscription.count();
}
