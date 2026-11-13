-- What a box gets installed the moment it joins a group.
--
-- The gap: a container that has just come up, or a box somebody has just
-- flashed, is in its group with nothing on it. Everything else the fleet does
-- assumes the scanner and its MITM are already there, so the first thing after
-- every scale-up was a trip to Manual deploy to install the same two builds on
-- the same kind of box again.
--
-- No rows are created here, and that is the point: this table drives rollouts
-- with nobody pressing anything, so it starts empty on every group and stays
-- that way until an operator puts a build in it.
--
-- VARCHAR(191) for every id, because that is what a cuid is on this provider
-- and the foreign keys below need the columns to match exactly. DATETIME(3)
-- rather than TIMESTAMP(3), matching every other createdAt in this schema.
CREATE TABLE `GroupJoinInstall` (
    `id` VARCHAR(191) NOT NULL,
    `groupId` VARCHAR(191) NOT NULL,
    `appVersionId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `GroupJoinInstall_groupId_appVersionId_key`(`groupId`, `appVersionId`),
    INDEX `GroupJoinInstall_appVersionId_idx`(`appVersionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CASCADE on both sides, unlike the group links elsewhere in this schema,
-- because this row is only an instruction about a pair. A deleted group has no
-- boxes left to join it, and a deleted build cannot be installed -- in either
-- case the instruction is not something to preserve with half of it missing.
ALTER TABLE `GroupJoinInstall` ADD CONSTRAINT `GroupJoinInstall_groupId_fkey` FOREIGN KEY (`groupId`) REFERENCES `DeviceGroup`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `GroupJoinInstall` ADD CONSTRAINT `GroupJoinInstall_appVersionId_fkey` FOREIGN KEY (`appVersionId`) REFERENCES `AppVersion`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
