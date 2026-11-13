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
ALTER TABLE "Device" ADD COLUMN "maintenanceUntil" TIMESTAMP(3);

-- Read by the scheduler, the monitor pass and the auto-update targeting on
-- every tick, always as "which boxes are parked right now".
--
-- Not a partial index, although `WHERE "maintenanceUntil" IS NOT NULL` would
-- cover only the handful of rows that matter: Prisma compares the database to
-- the schema, which cannot express one, so a partial index here is an index
-- the next `migrate dev` writes a migration to drop.
CREATE INDEX "Device_maintenanceUntil_idx" ON "Device"("maintenanceUntil");

-- CreateEnum
CREATE TYPE "DeviceScreenshotState" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateTable
--
-- Uploaded over HTTP with the box's own device token, like a log bundle and
-- for the same reason: the socket caps a frame at 1 MB and a 1080p PNG is
-- regularly more than that.
CREATE TABLE "DeviceScreenshot" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "state" "DeviceScreenshotState" NOT NULL DEFAULT 'PENDING',
    "path" TEXT,
    "sizeBytes" BIGINT,
    "error" TEXT,
    "requestedById" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "DeviceScreenshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DeviceScreenshot_deviceId_requestedAt_idx" ON "DeviceScreenshot"("deviceId", "requestedAt");

-- CASCADE, like every other per-device record: a deleted box has no
-- screenshots worth keeping, and the file on disk goes with the prune.
ALTER TABLE "DeviceScreenshot" ADD CONSTRAINT "DeviceScreenshot_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterEnum
--
-- Nothing new on the wire for these three. `memAvailableBytes`, `freeBytes`
-- and `cpuTempC` arrive on every heartbeat already and are drawn in the Load
-- card; the hub simply never compared them against anything.
ALTER TYPE "MonitorSignal" ADD VALUE 'DEVICE_MEMORY_LOW';
ALTER TYPE "MonitorSignal" ADD VALUE 'DEVICE_STORAGE_LOW';
ALTER TYPE "MonitorSignal" ADD VALUE 'DEVICE_TEMP_HIGH';
