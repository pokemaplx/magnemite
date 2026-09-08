-- Web push, alongside Discord. One row per browser that opted in.
--
-- Keyed by a sha256 of the endpoint rather than the endpoint itself: it has to
-- be unique, and a real endpoint runs past the 191 characters MariaDB will
-- index. The hash indexes the same on both providers.

-- CreateTable
CREATE TABLE `PushSubscription` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `endpointHash` VARCHAR(191) NOT NULL,
    `endpoint` TEXT NOT NULL,
    `p256dh` TEXT NOT NULL,
    `auth` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL DEFAULT '',
    `lastSentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PushSubscription_endpointHash_key`(`endpointHash`),
    INDEX `PushSubscription_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PushSubscription` ADD CONSTRAINT `PushSubscription_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
