"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { BellRing, Send } from "lucide-react";
import { sendTestAlert, updateMonitorSettings } from "@/actions/monitoring";
import { deletePushSubscription, savePushSubscription } from "@/actions/push";
import type { ActionState } from "@/actions/rollouts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { SaveButton } from "@/components/ui/save-button";
import { Switch } from "@/components/ui/switch";
import type { MonitorSettingsRow } from "@/components/settings/monitoring-section";

/**
 * Web push: a notification on the machine looking at this page.
 *
 * Its own file rather than a fourth card in `monitor-tuning-cards.tsx`,
 * because it is the only one that is not a form. The others read and write
 * settings; this one also talks to the browser — permissions, a service
 * worker, a subscription that exists on this machine and nowhere else — and
 * mixing that in beside three plain forms buried the difference.
 *
 * Two halves that look like one card and are not. The switch and the level
 * are fleet-wide settings, saved on Save like every other card here.
 * Subscribing is per browser and per person: it writes a row holding an
 * endpoint only this browser can be reached at, so it saves on the click, and
 * the button says "this browser" for that reason.
 *
 * There is nothing to paste in for the credential half. A push service only
 * accepts messages signed by the VAPID key it saw at subscription time, so
 * the keypair lives in the hub's environment and this card can only report
 * whether it is there.
 */

/**
 * The VAPID public key arrives base64url and `pushManager.subscribe` wants
 * bytes. Nothing in the platform does this conversion, so every web push
 * implementation carries a copy of it.
 */
function decodeVapidKey(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = `${base64Url}${"=".repeat((4 - (base64Url.length % 4)) % 4)}`
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  // Built on an ArrayBuffer we allocate rather than with `Uint8Array.from`:
  // `subscribe` wants a BufferSource, and the inferred type of `from` allows a
  // SharedArrayBuffer behind it, which is not one.
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Something a person can recognise in a list of four. Cosmetic, best effort. */
function browserLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad/.test(ua)
        ? "iOS"
        : /Mac OS X/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}

export function MonitorWebPushCard({
  settings,
  disabled,
  vapidPublicKey,
  subscribedCount,
}: {
  settings: MonitorSettingsRow;
  disabled: boolean;
  /** Null when the hub has no VAPID keypair, which no form here can fix. */
  vapidPublicKey: string | null;
  subscribedCount: number;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(updateMonitorSettings, {});
  const [enabled, setEnabled] = useState(settings.webPushEnabled);
  const [test, setTest] = useState<ActionState>({});
  const [pending, startTransition] = useTransition();

  // `undefined` while the browser is still being asked. Rendering "not
  // subscribed" during that moment makes an already-subscribed browser flash
  // a button that would have unsubscribed it.
  const [subscription, setSubscription] = useState<PushSubscription | null | undefined>(undefined);
  const [supported, setSupported] = useState(true);
  const [browserError, setBrowserError] = useState<string | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setSupported(false);
      setSubscription(null);
      return;
    }
    let live = true;
    // Only *read* the registration here. Registering a worker for everyone
    // who opens Settings would install a background script on machines that
    // never asked for notifications.
    void navigator.serviceWorker
      .getRegistration("/")
      .then(async (registration) =>
        registration ? registration.pushManager.getSubscription() : null,
      )
      .then((found) => {
        if (live) setSubscription(found);
      })
      .catch(() => {
        if (live) setSubscription(null);
      });
    return () => {
      live = false;
    };
  }, []);

  const subscribe = () => {
    if (!vapidPublicKey) return;
    setBrowserError(null);
    startTransition(async () => {
      try {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          setBrowserError(
            permission === "denied"
              ? "This browser is blocking notifications for this site. Allow them in the address bar's site settings, then try again."
              : "Notifications were not allowed.",
          );
          return;
        }

        const registration = await navigator.serviceWorker.register("/sw.js");
        // `register` resolves before the worker is running, and subscribing
        // against one that is not active yet fails on Firefox.
        await navigator.serviceWorker.ready;

        const created = await registration.pushManager.subscribe({
          // Required by every browser: a push that shows nothing is how this
          // API gets used for tracking, so it is simply not allowed.
          userVisibleOnly: true,
          applicationServerKey: decodeVapidKey(vapidPublicKey),
        });

        const result = await savePushSubscription(
          created.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } },
          browserLabel(),
        );
        if (result.error) {
          // Never leave an endpoint the server does not know about: it would
          // read as subscribed here and receive nothing forever.
          await created.unsubscribe();
          setBrowserError(result.error);
          return;
        }
        setSubscription(created);
      } catch (err) {
        setBrowserError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const unsubscribe = () => {
    if (!subscription) return;
    setBrowserError(null);
    startTransition(async () => {
      const { endpoint } = subscription;
      try {
        await subscription.unsubscribe();
      } finally {
        // Even where the browser refused to unsubscribe, drop the row: the
        // point of the click was to stop the notifications.
        await deletePushSubscription(endpoint);
        setSubscription(null);
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BellRing className="h-4 w-4 text-muted-foreground" />
          Web push
        </CardTitle>
        <CardDescription>
          A desktop or phone notification from the dashboard itself, to whoever asked for one. No
          Discord, nothing to install.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        {vapidPublicKey ? null : (
          <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            The hub has no VAPID keypair, so no browser can subscribe. Generate one with{" "}
            <span className="font-mono">npx web-push generate-vapid-keys</span>, then set{" "}
            <span className="font-mono">VAPID_PUBLIC_KEY</span>,{" "}
            <span className="font-mono">VAPID_PRIVATE_KEY</span> and{" "}
            <span className="font-mono">VAPID_SUBJECT</span> in the hub&rsquo;s environment. Keep
            them: regenerating the pair silently unsubscribes every browser.
          </p>
        )}

        <form action={formAction} className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Label htmlFor="webPushEnabled">Send alerts by web push</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                Off leaves the subscriptions in place and simply stops using them. Which rules use
                this channel is set on each rule.
              </p>
            </div>
            <Switch
              id="webPushEnabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={disabled || !vapidPublicKey}
            />
            {/* Posted explicitly rather than left to the switch. An absent
                field means "this card does not own it" to the action, and an
                unchecked switch that posts nothing is indistinguishable from
                that — which is how a save from another card would read as
                turning this off. */}
            <input type="hidden" name="webPushEnabled" value={enabled ? "on" : "off"} />
          </div>

          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          {test.error ? <p className="text-sm text-destructive">{test.error}</p> : null}
          {test.ok ? <p className="text-sm text-success">{test.message}</p> : null}

          {!disabled ? (
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  startTransition(async () => setTest(await sendTestAlert()));
                }}
              >
                <Send className="h-4 w-4" />
                Send test alert
              </Button>
              <SaveButton state={state} />
            </div>
          ) : null}
        </form>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
          <div>
            <p className="text-sm font-medium">This browser</p>
            <p className="text-xs text-muted-foreground">
              {!supported
                ? "This browser cannot do web push. On iOS the dashboard has to be added to the Home Screen first."
                : subscription === undefined
                  ? "Checking…"
                  : subscription
                    ? "Subscribed. Alerts arrive even with every tab closed."
                    : "Not subscribed."}{" "}
              {subscribedCount > 0
                ? `${subscribedCount} browser${subscribedCount === 1 ? "" : "s"} subscribed in total.`
                : null}
            </p>
            {browserError ? <p className="mt-1 text-xs text-destructive">{browserError}</p> : null}
          </div>

          {supported && subscription !== undefined ? (
            <Button
              type="button"
              variant={subscription ? "outline" : "default"}
              disabled={pending || !vapidPublicKey}
              onClick={subscription ? unsubscribe : subscribe}
            >
              {subscription ? "Unsubscribe this browser" : "Notify this browser"}
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
