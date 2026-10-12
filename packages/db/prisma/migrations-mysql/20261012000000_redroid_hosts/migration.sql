-- Redroid hosts: the Linux machine a container runs on, as a first-class
-- thing the fleet can see and scale.
--
-- A host is a Device with `kind = HOST`, not an entity of its own, which is
-- what lets the socket, the enrollment, the metrics, the prune, the offline
-- sweep and the self-update all apply to it unchanged. Everything below is
-- additive and every new column is nullable or defaulted, so this migration
-- changes nothing about a running fleet: `kind` defaults to BOX, so every
-- existing row is a box, and the new enum values are unused until a rule
-- names one.
--
-- MySQL spells an enum inline on every column that uses it, so widening one
-- means rewriting each of those column definitions rather than the one type --
-- and DeviceKind is spelled out three times below for the same reason.

-- AlterTable
--
-- cpuPercent is the reading a container actually has: its load average is the
-- host's and says nothing about it, but its own cgroup accounts its CPU time
-- exactly. Swap is a host's, and is what stands between fifty workers and the
-- OOM killer.
ALTER TABLE `Device` ADD COLUMN `kind` ENUM('BOX', 'HOST') NOT NULL DEFAULT 'BOX',
    ADD COLUMN `cpuPercent` DOUBLE NULL,
    ADD COLUMN `swapTotalBytes` BIGINT NULL,
    ADD COLUMN `swapFreeBytes` BIGINT NULL;

-- AlterTable
ALTER TABLE `DeviceMetricSample` ADD COLUMN `cpuPercent` DOUBLE NULL,
    ADD COLUMN `swapTotalBytes` BIGINT NULL,
    ADD COLUMN `swapFreeBytes` BIGINT NULL;

-- AlterTable
ALTER TABLE `EnrollmentToken` ADD COLUMN `kind` ENUM('BOX', 'HOST') NOT NULL DEFAULT 'BOX';

-- AlterTable
ALTER TABLE `MonitorRule` ADD COLUMN `appliesTo` ENUM('BOX', 'HOST') NOT NULL DEFAULT 'BOX';

-- AlterTable
ALTER TABLE `MonitorRule` MODIFY `signal` ENUM('AGENT_OFFLINE', 'SERVICE_DOWN', 'APP_NOT_FOREGROUND', 'APP_ANR', 'HEALTH_CHECK_FAILED', 'LOOP_STALLED', 'ROTOM_DISCONNECTED', 'ROTOM_NOT_SCANNING', 'ROTOM_IDLE', 'HOST_DOCKER_DOWN', 'HOST_MEMORY_LOW', 'HOST_DISK_LOW', 'REDROID_INSTANCE_DOWN') NOT NULL;

-- AlterTable
ALTER TABLE `MonitorEvent` MODIFY `signal` ENUM('AGENT_OFFLINE', 'SERVICE_DOWN', 'APP_NOT_FOREGROUND', 'APP_ANR', 'HEALTH_CHECK_FAILED', 'LOOP_STALLED', 'ROTOM_DISCONNECTED', 'ROTOM_NOT_SCANNING', 'ROTOM_IDLE', 'HOST_DOCKER_DOWN', 'HOST_MEMORY_LOW', 'HOST_DISK_LOW', 'REDROID_INSTANCE_DOWN') NOT NULL;

-- AlterTable
ALTER TABLE `MonitorStep` MODIFY `action` ENUM('NOTIFY_ONLY', 'RESTART_APP', 'KILL_APP', 'CLEAR_CACHE_RESTART', 'SEND_KEYEVENT', 'START_SERVICE', 'SHELL', 'REBOOT', 'ROTOM_RESTART', 'ROTOM_DISCONNECT', 'ROTOM_REBOOT', 'RESTART_INSTANCE') NOT NULL;

-- AlterTable
ALTER TABLE `MonitorEvent` MODIFY `action` ENUM('NOTIFY_ONLY', 'RESTART_APP', 'KILL_APP', 'CLEAR_CACHE_RESTART', 'SEND_KEYEVENT', 'START_SERVICE', 'SHELL', 'REBOOT', 'ROTOM_RESTART', 'ROTOM_DISCONNECT', 'ROTOM_REBOOT', 'RESTART_INSTANCE') NULL;

-- CreateIndex
--
-- Every fleet-wide query is "the boxes, by state". Leading on kind keeps the
-- hosts out of it without a second scan.
CREATE INDEX `Device_kind_status_idx` ON `Device`(`kind`, `status`);

-- CreateTable
CREATE TABLE `RedroidHost` (
    `deviceId` VARCHAR(191) NOT NULL,
    `project` VARCHAR(191) NOT NULL DEFAULT 'magnemite-redroid',
    `dir` VARCHAR(191) NOT NULL DEFAULT '/etc/magnemite/redroid',
    `appliedSha256` VARCHAR(191) NULL,
    `appliedAt` DATETIME(3) NULL,
    `adoptedAt` DATETIME(3) NULL,
    `lastError` TEXT NULL,
    `lastErrorAt` DATETIME(3) NULL,
    `memLimitBytes` BIGINT NULL,
    `cpuset` VARCHAR(191) NULL,
    `gpuMode` VARCHAR(191) NULL,
    `image` VARCHAR(191) NULL,
    `defaultGroupId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `RedroidHost_defaultGroupId_idx`(`defaultGroupId`),
    PRIMARY KEY (`deviceId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
--
-- `index` is a reserved word in MySQL, hence the backticks everywhere it
-- appears below.
CREATE TABLE `RedroidInstance` (
    `id` VARCHAR(191) NOT NULL,
    `hostId` VARCHAR(191) NOT NULL,
    `index` INTEGER NOT NULL,
    `serial` VARCHAR(191) NOT NULL,
    `deviceId` VARCHAR(191) NULL,
    `present` BOOLEAN NOT NULL DEFAULT true,
    `workers` INTEGER NULL,
    `memLimitBytes` BIGINT NULL,
    `cpuset` VARCHAR(191) NULL,
    `image` VARCHAR(191) NULL,
    `containerState` VARCHAR(191) NULL,
    `restartCount` INTEGER NULL,
    `appliedMemLimitBytes` BIGINT NULL,
    `reportedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `RedroidInstance_serial_key`(`serial`),
    UNIQUE INDEX `RedroidInstance_deviceId_key`(`deviceId`),
    UNIQUE INDEX `RedroidInstance_hostId_index_key`(`hostId`, `index`),
    INDEX `RedroidInstance_hostId_present_idx`(`hostId`, `present`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `RedroidHost` ADD CONSTRAINT `RedroidHost_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RedroidHost` ADD CONSTRAINT `RedroidHost_defaultGroupId_fkey` FOREIGN KEY (`defaultGroupId`) REFERENCES `DeviceGroup`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RedroidInstance` ADD CONSTRAINT `RedroidInstance_hostId_fkey` FOREIGN KEY (`hostId`) REFERENCES `RedroidHost`(`deviceId`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
--
-- SetNull, not Cascade: deleting a box must not delete the instance row that
-- minted its serial, or the container would come back as a brand-new box with
-- no history. "Remove" keeps the row; only "forget" deletes it.
ALTER TABLE `RedroidInstance` ADD CONSTRAINT `RedroidInstance_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
