-- What a new Redroid instance needs to read as being set up, rather than as a
-- badge going unknown, absent, running.

-- AlterTable
--
-- A converge asked for while the machine was offline, kept to on its next
-- hello -- which is what "it will converge when it reconnects" had promised
-- and nothing did. Notably a machine provisioned with instances: it is adopted
-- as it enrols, over HTTP and before its socket exists, so its first converge
-- was always refused as offline.
--
-- A flag rather than "the compose file differs": a hub deploy that changes the
-- rendered file must not have every machine recreate its containers on
-- reconnect. Only a converge somebody asked for is owed.
ALTER TABLE `RedroidHost` ADD COLUMN `convergeOwedAt` DATETIME(3) NULL;

-- AlterTable
--
-- When an instance was last asked for: created, or brought back after a
-- removal. What the dashboard times its setup from -- `createdAt` cannot
-- stand in, as a revived row keeps the one it had the first time. Left null
-- on the rows already here, which were set up long ago.
ALTER TABLE `RedroidInstance` ADD COLUMN `requestedAt` DATETIME(3) NULL;
