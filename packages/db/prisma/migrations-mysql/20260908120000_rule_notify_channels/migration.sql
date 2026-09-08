-- A rule picks its channels, instead of a yes/no that meant "all of them".
--
-- And the per-channel "announce at least" goes away with it. Two filters in
-- series -- the rule's channels and the channel's floor -- meant a rule that
-- says "ntfy" could silently not reach ntfy, with nothing on the rule to say
-- why. One filter, on the rule, where somebody looking for the reason is
-- already looking. `notifyLevel` stays and still decides how an alert looks:
-- the embed colour, ntfy's priority, whether a browser notification sticks.

-- AlterTable: nullable first, so the backfill below has somewhere to land.
-- MySQL cannot give a JSON column a DEFAULT at all, which is the other reason
-- this is three statements rather than one.
ALTER TABLE `MonitorRule` ADD COLUMN `notifyChannels` JSON NULL;

-- An announcing rule announced to everything that was configured, so every
-- channel is what it meant. A silent one stays silent.
UPDATE `MonitorRule` SET `notifyChannels` = '["discord", "ntfy", "webPush"]' WHERE `notify` = true;
UPDATE `MonitorRule` SET `notifyChannels` = '[]' WHERE `notify` = false;

ALTER TABLE `MonitorRule` MODIFY `notifyChannels` JSON NOT NULL;
ALTER TABLE `MonitorRule` DROP COLUMN `notify`;

-- The three floors. Left behind they would be settings that are read by
-- nothing and quietly ignored, which is the trap this project has been bitten
-- by before.
DELETE FROM `Setting` WHERE `key` IN ('monitor.discordMinLevel', 'monitor.ntfyMinLevel', 'monitor.webPushMinLevel');
