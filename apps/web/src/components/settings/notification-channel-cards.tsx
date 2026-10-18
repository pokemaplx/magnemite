"use client";

import { useActionState, useState, useTransition } from "react";
import { MessageSquare, Send, Smartphone } from "lucide-react";
import type { NotifyChannel } from "@magnemite/db";
import { sendTestNotification, updateNotificationSettings } from "@/actions/notifications";
import type { ActionState } from "@/actions/rollouts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveButton } from "@/components/ui/save-button";
import { Outcome } from "@/components/settings/setting-fields";
import type { NotifySettingsRow } from "@/components/settings/notifications-section";

/**
 * The Discord and ntfy cards, and the pieces every channel card shares.
 *
 * Moved here from the Tuning tab when the channels stopped being only
 * monitoring's. Each card is still its own form posting only its own fields,
 * and the action keeps whatever a card did not send — the contract that
 * stops saving one channel from wiping another.
 */

/** Whether the channel will send anything at all, said before the fields. */
export function ChannelStatus({ ready }: { ready: boolean }) {
  return ready ? <Badge variant="success">Set up</Badge> : <Badge variant="outline">Off</Badge>;
}

/**
 * One channel's test: the button and what came back.
 *
 * Only its own channel — a test that fanned out to all three meant a phone
 * buzzing for somebody fixing a webhook.
 */
export function useChannelTest(channel: NotifyChannel) {
  const [result, setResult] = useState<ActionState>({});
  const [testing, startTransition] = useTransition();
  const run = () => startTransition(async () => setResult(await sendTestNotification(channel)));
  return { result, testing, run };
}

export function TestOutcome({ result }: { result: ActionState }) {
  if (result.error) return <p className="text-sm text-destructive">{result.error}</p>;
  if (result.ok) return <p className="text-sm text-success">{result.message}</p>;
  return null;
}

export function TestButton({ testing, onClick }: { testing: boolean; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      disabled={testing}
      onClick={onClick}
      // The hub sends with what is stored, not with what is typed in the card,
      // because that is what every real notification will use.
      title="Sends one message with the saved settings — save first if you changed something."
    >
      <Send className="h-4 w-4" />
      {testing ? "Sending…" : "Send test"}
    </Button>
  );
}

/**
 * A credential a viewer is not sent. The page blanks it for them, so a field
 * that is empty on a channel that is set up is withheld rather than missing,
 * and says so instead of looking unconfigured.
 */
function withheld(disabled: boolean, ready: boolean, value: string): boolean {
  return disabled && ready && !value;
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

export function DiscordCard({
  settings,
  ready,
  disabled,
}: {
  settings: NotifySettingsRow;
  ready: boolean;
  disabled: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(updateNotificationSettings, {});
  const test = useChannelTest("discord");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          Discord
          <ChannelStatus ready={ready} />
        </CardTitle>
        <CardDescription>
          A message in a Discord channel, through a webhook. Empty turns Discord off and leaves
          everything else running.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {/* Only this card's fields are posted: the action keeps everything it
            does not see. This form once mirrored the other cards' values in
            hidden inputs, and one of them was missing — which is what made
            saving a webhook fail over a number that was not on this card. */}
        <form action={formAction} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="discordWebhookUrl">Webhook URL</Label>
            <Input
              id="discordWebhookUrl"
              name="discordWebhookUrl"
              type="url"
              placeholder={
                withheld(disabled, ready, settings.discordWebhookUrl)
                  ? "Set — only operators can see it"
                  : "https://discord.com/api/webhooks/…"
              }
              defaultValue={settings.discordWebhookUrl}
              disabled={disabled}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              From the channel&rsquo;s Integrations settings, under Webhooks.
            </p>
          </div>

          <div className="flex flex-col gap-1.5 sm:max-w-xs">
            <Label htmlFor="discordMentionRoleId">Role to ping (optional)</Label>
            <Input
              id="discordMentionRoleId"
              name="discordMentionRoleId"
              placeholder="123456789012345678"
              defaultValue={settings.discordMentionRoleId}
              disabled={disabled}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Pinged on critical alerts only. Fleet events never ping.
            </p>
          </div>

          <Outcome state={state} />
          <TestOutcome result={test.result} />

          {!disabled ? (
            <div className="flex flex-wrap justify-end gap-2">
              <TestButton testing={test.testing} onClick={test.run} />
              <SaveButton state={state} />
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ntfy
// ---------------------------------------------------------------------------

export function NtfyCard({
  settings,
  ready,
  disabled,
}: {
  settings: NotifySettingsRow;
  ready: boolean;
  disabled: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(updateNotificationSettings, {});
  const test = useChannelTest("ntfy");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-muted-foreground" />
          ntfy
          <ChannelStatus ready={ready} />
        </CardTitle>
        <CardDescription>
          A push notification on a phone, without an account anywhere. An empty topic turns it off
          and leaves everything else running.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form action={formAction} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ntfyUrl">Server</Label>
              <Input
                id="ntfyUrl"
                name="ntfyUrl"
                type="url"
                placeholder="https://ntfy.sh"
                defaultValue={settings.ntfyUrl}
                disabled={disabled}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                The public ntfy.sh, or your own. Install the ntfy app and subscribe to the topic.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ntfyTopic">Topic</Label>
              <Input
                id="ntfyTopic"
                name="ntfyTopic"
                placeholder={
                  withheld(disabled, ready, settings.ntfyTopic)
                    ? "Set — only operators can see it"
                    : "magnemite-3f9a2c"
                }
                defaultValue={settings.ntfyTopic}
                disabled={disabled}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                On ntfy.sh anyone who guesses the topic reads your notifications, so pick a name
                nobody would.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-1.5 sm:max-w-xs">
            <Label htmlFor="ntfyToken">Access token (optional)</Label>
            <Input
              id="ntfyToken"
              name="ntfyToken"
              type="password"
              placeholder="tk_…"
              defaultValue={settings.ntfyToken}
              disabled={disabled}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Only for a protected or reserved topic. Empty publishes anonymously.
            </p>
          </div>

          <Outcome state={state} />
          <TestOutcome result={test.result} />

          {!disabled ? (
            <div className="flex flex-wrap justify-end gap-2">
              <TestButton testing={test.testing} onClick={test.run} />
              <SaveButton state={state} />
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
