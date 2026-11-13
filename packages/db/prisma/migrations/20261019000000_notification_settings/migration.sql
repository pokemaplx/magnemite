-- Where alerts go moves out of the monitoring group into one of its own. The
-- monitor stopped being the only thing that announces -- rollouts, builds and
-- machines do now -- and all of them go out through the same three channels,
-- so the channels belong to none of them. Groups are a key prefix in this
-- table, so the move is a rename, one key at a time.
UPDATE "Setting" SET "key" = 'notify.discordWebhookUrl'
WHERE "key" = 'monitor.discordWebhookUrl'
  AND NOT EXISTS (SELECT 1 FROM "Setting" s WHERE s."key" = 'notify.discordWebhookUrl');

UPDATE "Setting" SET "key" = 'notify.discordMentionRoleId'
WHERE "key" = 'monitor.discordMentionRoleId'
  AND NOT EXISTS (SELECT 1 FROM "Setting" s WHERE s."key" = 'notify.discordMentionRoleId');

UPDATE "Setting" SET "key" = 'notify.ntfyUrl'
WHERE "key" = 'monitor.ntfyUrl'
  AND NOT EXISTS (SELECT 1 FROM "Setting" s WHERE s."key" = 'notify.ntfyUrl');

UPDATE "Setting" SET "key" = 'notify.ntfyTopic'
WHERE "key" = 'monitor.ntfyTopic'
  AND NOT EXISTS (SELECT 1 FROM "Setting" s WHERE s."key" = 'notify.ntfyTopic');

UPDATE "Setting" SET "key" = 'notify.ntfyToken'
WHERE "key" = 'monitor.ntfyToken'
  AND NOT EXISTS (SELECT 1 FROM "Setting" s WHERE s."key" = 'notify.ntfyToken');

UPDATE "Setting" SET "key" = 'notify.webPushEnabled'
WHERE "key" = 'monitor.webPushEnabled'
  AND NOT EXISTS (SELECT 1 FROM "Setting" s WHERE s."key" = 'notify.webPushEnabled');

-- The repeat window goes with them: it decides whether a message is sent, not
-- whether a box is acted on.
UPDATE "Setting" SET "key" = 'notify.alertDedupeMinutes'
WHERE "key" = 'monitor.alertDedupeMinutes'
  AND NOT EXISTS (SELECT 1 FROM "Setting" s WHERE s."key" = 'notify.alertDedupeMinutes');

-- Only reachable when both keys somehow existed; the monitor one is the stale
-- copy either way.
DELETE FROM "Setting" WHERE "key" IN (
  'monitor.discordWebhookUrl',
  'monitor.discordMentionRoleId',
  'monitor.ntfyUrl',
  'monitor.ntfyTopic',
  'monitor.ntfyToken',
  'monitor.webPushEnabled',
  'monitor.alertDedupeMinutes'
);
