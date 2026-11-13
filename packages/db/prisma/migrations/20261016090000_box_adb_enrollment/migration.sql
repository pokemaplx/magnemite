-- Enrolling hardware boxes over adb, from the dashboard, the way a machine is
-- already provisioned over SSH.
--
-- Entirely additive: two new tables, two new enums and one nullable column on
-- RedroidHost. Nothing existing changes shape, so a running fleet notices
-- nothing until somebody opens the dialog.

-- CreateEnum
CREATE TYPE "BoxEnrollState" AS ENUM ('RUNNING', 'WAITING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "BoxSerialSource" AS ENUM ('REPORTED', 'MINTED');

-- AlterTable
--
-- A relay machine's own adb public key. Each keeps its own rather than
-- sharing the hub's, because a key a box has trusted is a root shell on that
-- box and a relay can be a machine in somebody's living room.
ALTER TABLE "RedroidHost" ADD COLUMN     "adbPublicKey" TEXT;

-- CreateTable
--
-- One row, holding the adb identity the hub presents. In the database and not
-- in ARTIFACT_DIR on purpose: that volume is served, and `/files/*` only
-- rejects a basename starting with a dot -- so `adb/.android/adbkey` would be
-- downloadable by any approved device token.
CREATE TABLE "AdbIdentity" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "privateKeyPem" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdbIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoxEnroll" (
    "id" TEXT NOT NULL,
    "batchId" TEXT,
    "address" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "serialSource" "BoxSerialSource" NOT NULL DEFAULT 'REPORTED',
    "desiredName" TEXT,
    "desiredGroupId" TEXT,
    "relayDeviceId" TEXT,
    "state" "BoxEnrollState" NOT NULL DEFAULT 'RUNNING',
    "steps" JSONB,
    "error" TEXT,
    "deviceId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "BoxEnroll_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BoxEnroll_state_idx" ON "BoxEnroll"("state");

-- CreateIndex
--
-- Not unique, unlike RedroidBootstrap's. That one mints a fresh serial every
-- run; this one is usually the box's own ro.serialno, which is the same value
-- on a retry -- so a unique index would make a second attempt impossible to
-- record. The claim reads the newest live row instead.
CREATE INDEX "BoxEnroll_serial_idx" ON "BoxEnroll"("serial");

-- CreateIndex
CREATE INDEX "BoxEnroll_batchId_idx" ON "BoxEnroll"("batchId");

-- CreateIndex
CREATE INDEX "BoxEnroll_deviceId_idx" ON "BoxEnroll"("deviceId");

-- CreateIndex
CREATE INDEX "BoxEnroll_desiredGroupId_idx" ON "BoxEnroll"("desiredGroupId");

-- CreateIndex
CREATE INDEX "BoxEnroll_relayDeviceId_idx" ON "BoxEnroll"("relayDeviceId");

-- AddForeignKey
ALTER TABLE "BoxEnroll" ADD CONSTRAINT "BoxEnroll_desiredGroupId_fkey" FOREIGN KEY ("desiredGroupId") REFERENCES "DeviceGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoxEnroll" ADD CONSTRAINT "BoxEnroll_relayDeviceId_fkey" FOREIGN KEY ("relayDeviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoxEnroll" ADD CONSTRAINT "BoxEnroll_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;
