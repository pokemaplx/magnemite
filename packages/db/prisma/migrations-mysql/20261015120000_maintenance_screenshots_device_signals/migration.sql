-- Three features that share one migration because each is a column or an enum
-- value and none of them is worth a migration of its own.
--
-- 1. Maintenance: a box somebody is working on by hand.
-- 2. Screenshots: one `screencap` per request, shaped like a log bundle.
-- 3. Three monitoring signals read off readings the agent already sends.

-- AlterTable
--
-- While this is in the future the box is skipped by everything the fleet does
-- on its own initiative, and a rollout aimed at it is refused saying so. A
-- timestamp rather than a boolean, because a flag left on is a box that
-- quietly stops being watched.
--
-- DATETIME(3), matching every other nullable timestamp on this table.
ALTER TABLE `Device` ADD COLUMN `maintenanceUntil` DATETIME(3) NULL;

-- Read by the scheduler, the monitor pass and the auto-update targeting on
-- every tick, always as "which boxes are parked right now". Declared in the
-- schema, so both providers get the same plain index.
CREATE INDEX `Device_maintenanceUntil_idx` ON `Device`(`maintenanceUntil`);

-- CreateTable
--
-- Uploaded over HTTP with the box's own device token, like a log bundle and
-- for the same reason: the socket caps a frame at 1 MB and a 1080p PNG is
-- regularly more than that.
--
-- VARCHAR(191) for every id, because that is what a cuid is on this provider
-- and the foreign key below needs the columns to match exactly.
CREATE TABLE `DeviceScreenshot` (
    `id` VARCHAR(191) NOT NULL,
    `deviceId` VARCHAR(191) NOT NULL,
    `state` ENUM('PENDING', 'READY', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `path` VARCHAR(191) NULL,
    `sizeBytes` BIGINT NULL,
    `error` TEXT NULL,
    `requestedById` VARCHAR(191) NULL,
    `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,

    INDEX `DeviceScreenshot_deviceId_requestedAt_idx`(`deviceId`, `requestedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CASCADE, like every other per-device record: a deleted box has no
-- screenshots worth keeping, and the file on disk goes with the prune.
ALTER TABLE `DeviceScreenshot` ADD CONSTRAINT `DeviceScreenshot_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
--
-- An inline ENUM on this provider rather than a type, so adding a value means
-- restating the whole list on both columns that hold one, in the schema's own
-- order.
--
-- Nothing new on the wire for these three. `memAvailableBytes`, `freeBytes`
-- and `cpuTempC` arrive on every heartbeat already and are drawn in the Load
-- card; the hub simply never compared them against anything.
ALTER TABLE `MonitorRule` MODIFY `signal` ENUM('AGENT_OFFLINE', 'SERVICE_DOWN', 'APP_NOT_FOREGROUND', 'APP_ANR', 'HEALTH_CHECK_FAILED', 'LOOP_STALLED', 'ROTOM_DISCONNECTED', 'ROTOM_NOT_SCANNING', 'ROTOM_IDLE', 'DEVICE_MEMORY_LOW', 'DEVICE_STORAGE_LOW', 'DEVICE_TEMP_HIGH', 'HOST_DOCKER_DOWN', 'HOST_MEMORY_LOW', 'HOST_DISK_LOW', 'REDROID_INSTANCE_DOWN') NOT NULL;

ALTER TABLE `MonitorEvent` MODIFY `signal` ENUM('AGENT_OFFLINE', 'SERVICE_DOWN', 'APP_NOT_FOREGROUND', 'APP_ANR', 'HEALTH_CHECK_FAILED', 'LOOP_STALLED', 'ROTOM_DISCONNECTED', 'ROTOM_NOT_SCANNING', 'ROTOM_IDLE', 'DEVICE_MEMORY_LOW', 'DEVICE_STORAGE_LOW', 'DEVICE_TEMP_HIGH', 'HOST_DOCKER_DOWN', 'HOST_MEMORY_LOW', 'HOST_DISK_LOW', 'REDROID_INSTANCE_DOWN') NOT NULL;
