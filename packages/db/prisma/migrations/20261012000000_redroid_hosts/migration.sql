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

-- CreateEnum
CREATE TYPE "DeviceKind" AS ENUM ('BOX', 'HOST');

-- AlterEnum
ALTER TYPE "MonitorSignal" ADD VALUE 'HOST_DOCKER_DOWN';
ALTER TYPE "MonitorSignal" ADD VALUE 'HOST_MEMORY_LOW';
ALTER TYPE "MonitorSignal" ADD VALUE 'HOST_DISK_LOW';
ALTER TYPE "MonitorSignal" ADD VALUE 'REDROID_INSTANCE_DOWN';

-- AlterEnum
ALTER TYPE "MonitorAction" ADD VALUE 'RESTART_INSTANCE';

-- AlterTable
--
-- cpuPercent is the reading a container actually has: its load average is the
-- host's and says nothing about it, but its own cgroup accounts its CPU time
-- exactly. Swap is a host's, and is what stands between fifty workers and the
-- OOM killer.
ALTER TABLE "Device" ADD COLUMN     "kind" "DeviceKind" NOT NULL DEFAULT 'BOX',
ADD COLUMN     "cpuPercent" DOUBLE PRECISION,
ADD COLUMN     "swapTotalBytes" BIGINT,
ADD COLUMN     "swapFreeBytes" BIGINT;

-- AlterTable
ALTER TABLE "DeviceMetricSample" ADD COLUMN     "cpuPercent" DOUBLE PRECISION,
ADD COLUMN     "swapTotalBytes" BIGINT,
ADD COLUMN     "swapFreeBytes" BIGINT;

-- AlterTable
ALTER TABLE "EnrollmentToken" ADD COLUMN     "kind" "DeviceKind" NOT NULL DEFAULT 'BOX';

-- AlterTable
ALTER TABLE "MonitorRule" ADD COLUMN     "appliesTo" "DeviceKind" NOT NULL DEFAULT 'BOX';

-- CreateIndex
--
-- Every fleet-wide query is "the boxes, by state". Leading on kind keeps the
-- hosts out of it without a second scan.
CREATE INDEX "Device_kind_status_idx" ON "Device"("kind", "status");

-- CreateTable
CREATE TABLE "RedroidHost" (
    "deviceId" TEXT NOT NULL,
    "arch" TEXT,
    "kernel" TEXT,
    "dockerVersion" TEXT,
    "binderOk" BOOLEAN,
    "project" TEXT NOT NULL DEFAULT 'magnemite-redroid',
    "dir" TEXT NOT NULL DEFAULT '/etc/magnemite/redroid',
    "appliedSha256" TEXT,
    "appliedAt" TIMESTAMP(3),
    "convergingSince" TIMESTAMP(3),
    "adoptedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "memLimitBytes" BIGINT,
    "cpuset" TEXT,
    "gpuMode" TEXT,
    "image" TEXT,
    "defaultGroupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RedroidHost_pkey" PRIMARY KEY ("deviceId")
);

-- CreateTable
CREATE TABLE "RedroidInstance" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "serial" TEXT NOT NULL,
    "deviceId" TEXT,
    "present" BOOLEAN NOT NULL DEFAULT true,
    "workers" INTEGER,
    "memLimitBytes" BIGINT,
    "cpuset" TEXT,
    "image" TEXT,
    "containerState" TEXT,
    "restartCount" INTEGER,
    "appliedMemLimitBytes" BIGINT,
    "reportedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RedroidInstance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RedroidInstance_serial_key" ON "RedroidInstance"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "RedroidInstance_deviceId_key" ON "RedroidInstance"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "RedroidInstance_hostId_index_key" ON "RedroidInstance"("hostId", "index");

-- CreateIndex
CREATE INDEX "RedroidInstance_hostId_present_idx" ON "RedroidInstance"("hostId", "present");

-- CreateIndex
CREATE INDEX "RedroidHost_defaultGroupId_idx" ON "RedroidHost"("defaultGroupId");

-- AddForeignKey
ALTER TABLE "RedroidHost" ADD CONSTRAINT "RedroidHost_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RedroidHost" ADD CONSTRAINT "RedroidHost_defaultGroupId_fkey" FOREIGN KEY ("defaultGroupId") REFERENCES "DeviceGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RedroidInstance" ADD CONSTRAINT "RedroidInstance_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "RedroidHost"("deviceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
--
-- SetNull, not Cascade: deleting a box must not delete the instance row that
-- minted its serial, or the container would come back as a brand-new box with
-- no history. "Remove" keeps the row; only "forget" deletes it.
ALTER TABLE "RedroidInstance" ADD CONSTRAINT "RedroidInstance_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;
