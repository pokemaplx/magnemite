-- One stretch where Magnemite lost contact with a box, and what it was.
--
-- Nothing recorded a disconnection before this. The close code and reason went
-- to the hub's stdout and were lost with it, so "why did POKELX03 go
-- unreachable at 21:54" had no answer anywhere -- and live logs and the log
-- bundle both need the box online, which is precisely what it was not.
--
-- An interval rather than a point, because the question is never "when did it
-- drop" but "what happened across that gap". The before/after pairs are what
-- answer it: a gap where the boot instant moved is a reboot, a gap where it
-- did not and the socket never closed is an agent that stalled.
--
-- VARCHAR(191) for the device id because that is what a cuid is on this
-- provider and the foreign key needs the columns to match exactly; DATETIME(3)
-- rather than TIMESTAMP(3), matching every other instant in this schema here.
ALTER TABLE `Device` ADD COLUMN `bootedAt` DATETIME(3) NULL;
ALTER TABLE `Device` ADD COLUMN `agentStartedAt` DATETIME(3) NULL;

CREATE TABLE `DeviceConnectionEvent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `deviceId` VARCHAR(191) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `endedAt` DATETIME(3) NULL,
    `durationSeconds` INTEGER NULL,
    `cause` ENUM('HUB_RESTART', 'REPLACED', 'DEVICE_DELETED', 'TERMINATED_BY_HUB', 'LINK_LOST', 'AGENT_RESTART', 'REBOOT', 'HEARTBEAT_STALL') NULL,
    `closeCode` INTEGER NULL,
    `closeReason` VARCHAR(191) NULL,
    `hubRestarted` BOOLEAN NOT NULL DEFAULT false,
    `uptimeBefore` INTEGER NULL,
    `bootedAtBefore` DATETIME(3) NULL,
    `agentStartedBefore` DATETIME(3) NULL,
    `agentVersionBefore` VARCHAR(191) NULL,
    `uptimeAfter` INTEGER NULL,
    `bootedAtAfter` DATETIME(3) NULL,
    `agentStartedAfter` DATETIME(3) NULL,
    `agentVersionAfter` VARCHAR(191) NULL,
    `bootReason` VARCHAR(191) NULL,
    `sessionAfter` VARCHAR(191) NULL,

    INDEX `DeviceConnectionEvent_deviceId_startedAt_idx`(`deviceId`, `startedAt`),
    INDEX `DeviceConnectionEvent_startedAt_idx`(`startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CASCADE: an episode is a fact about a box, and a box that is gone has no
-- history worth keeping half of.
ALTER TABLE `DeviceConnectionEvent` ADD CONSTRAINT `DeviceConnectionEvent_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
