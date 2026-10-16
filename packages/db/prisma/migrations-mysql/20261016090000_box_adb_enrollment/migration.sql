-- Enrolling hardware boxes over adb, from the dashboard, the way a machine is
-- already provisioned over SSH.
--
-- Entirely additive: two new tables and one nullable column on RedroidHost.
-- Nothing existing changes shape, so a running fleet notices nothing until
-- somebody opens the dialog.

-- AlterTable
--
-- A relay machine's own adb public key. Each keeps its own rather than
-- sharing the hub's, because a key a box has trusted is a root shell on that
-- box and a relay can be a machine in somebody's living room.
ALTER TABLE `RedroidHost` ADD COLUMN `adbPublicKey` TEXT NULL;

-- CreateTable
--
-- One row, holding the adb identity the hub presents. In the database and not
-- in ARTIFACT_DIR on purpose: that volume is served, and `/files/*` only
-- rejects a basename starting with a dot -- so `adb/.android/adbkey` would be
-- downloadable by any approved device token.
CREATE TABLE `AdbIdentity` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'singleton',
    `privateKeyPem` TEXT NOT NULL,
    `publicKey` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
--
-- The serial index is deliberately not unique, unlike RedroidBootstrap's.
-- That one mints a fresh serial every run; this one is usually the box's own
-- ro.serialno, which is the same value on a retry -- so a unique index would
-- make a second attempt impossible to record. The claim reads the newest live
-- row instead.
CREATE TABLE `BoxEnroll` (
    `id` VARCHAR(191) NOT NULL,
    `batchId` VARCHAR(191) NULL,
    `address` VARCHAR(191) NOT NULL,
    `serial` VARCHAR(191) NOT NULL,
    `serialSource` ENUM('REPORTED', 'MINTED') NOT NULL DEFAULT 'REPORTED',
    `desiredName` VARCHAR(191) NULL,
    `desiredGroupId` VARCHAR(191) NULL,
    `relayDeviceId` VARCHAR(191) NULL,
    `state` ENUM('RUNNING', 'WAITING', 'DONE', 'FAILED') NOT NULL DEFAULT 'RUNNING',
    `steps` JSON NULL,
    `error` TEXT NULL,
    `deviceId` VARCHAR(191) NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,

    INDEX `BoxEnroll_state_idx`(`state`),
    INDEX `BoxEnroll_serial_idx`(`serial`),
    INDEX `BoxEnroll_batchId_idx`(`batchId`),
    INDEX `BoxEnroll_deviceId_idx`(`deviceId`),
    INDEX `BoxEnroll_desiredGroupId_idx`(`desiredGroupId`),
    INDEX `BoxEnroll_relayDeviceId_idx`(`relayDeviceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `BoxEnroll` ADD CONSTRAINT `BoxEnroll_desiredGroupId_fkey` FOREIGN KEY (`desiredGroupId`) REFERENCES `DeviceGroup`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BoxEnroll` ADD CONSTRAINT `BoxEnroll_relayDeviceId_fkey` FOREIGN KEY (`relayDeviceId`) REFERENCES `Device`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BoxEnroll` ADD CONSTRAINT `BoxEnroll_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
