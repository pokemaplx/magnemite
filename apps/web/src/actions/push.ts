"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@magnemite/db";
import { requireUser } from "@/lib/session";
import type { ActionState } from "./rollouts";

/**
 * The browser half of web push: storing and forgetting subscriptions.
 *
 * Sending is the hub's job — it is what has the VAPID private key and what
 * knows a box went down. All that happens here is bookkeeping, which is why
 * it is `requireUser` rather than `requireOperator`: a VIEWER cannot change
 * anything about the fleet, but wanting to be told when it breaks is not a
 * change to the fleet.
 */

/** sha256 of the endpoint, hex. Matches `hashEndpoint` in the hub. */
function hashEndpoint(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

export type BrowserSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

/**
 * Remember this browser, or refresh what we know about it.
 *
 * Upserted on the endpoint hash rather than inserted: a browser that
 * re-subscribes — after a permission reset, or because the push service
 * rotated the endpoint's keys — must replace its row. Inserting instead is
 * how a fleet ends up sending four copies of every alert to one laptop.
 */
export async function savePushSubscription(
  subscription: BrowserSubscription,
  label: string,
): Promise<ActionState> {
  const user = await requireUser();

  if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    return { error: "The browser did not return a usable subscription." };
  }

  const endpointHash = hashEndpoint(subscription.endpoint);
  const data = {
    userId: user.id,
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    label: label.slice(0, 120),
  };

  await prisma.pushSubscription.upsert({
    where: { endpointHash },
    create: { endpointHash, ...data },
    // The user too: a shared machine where somebody else signed in should
    // have the alerts follow the account, not the browser.
    update: data,
  });

  revalidatePath("/settings");
  return { ok: true, message: "This browser will be notified." };
}

/** Forget one browser — the one that is asking, identified by its endpoint. */
export async function deletePushSubscription(endpoint: string): Promise<ActionState> {
  await requireUser();
  // deleteMany rather than delete: unsubscribing a browser whose row is
  // already gone (the hub dropped it as dead) is a success, not a crash.
  await prisma.pushSubscription.deleteMany({ where: { endpointHash: hashEndpoint(endpoint) } });
  revalidatePath("/settings");
  return { ok: true, message: "This browser will no longer be notified." };
}
