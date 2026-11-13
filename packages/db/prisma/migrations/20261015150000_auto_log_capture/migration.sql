-- Tie a log bundle to the episode it was collected to explain.
--
-- The window that explains an unreachable alert is gone by the time anybody
-- reads the alert: live logs and the bundle both need the box online, which is
-- what it was not. The box's own agent.log survives the gap on disk, so the
-- fix is to grab it on the way back rather than to ask for it later.
--
-- `reason` exists so the prune can keep the newest few per reason. With one
-- shared ceiling of three per device, a run of automatic captures would evict
-- the bundle an operator asked for, which is the one that matters most.
CREATE TYPE "DeviceLogBundleReason" AS ENUM ('OPERATOR', 'AUTO_RECOVERY');

ALTER TABLE "DeviceLogBundle" ADD COLUMN "reason" "DeviceLogBundleReason" NOT NULL DEFAULT 'OPERATOR';
ALTER TABLE "DeviceLogBundle" ADD COLUMN "connectionEventId" INTEGER;

CREATE INDEX "DeviceLogBundle_connectionEventId_idx" ON "DeviceLogBundle"("connectionEventId");

-- SET NULL rather than CASCADE: the zip is still a real file worth keeping
-- once the episode behind it has aged out of its own retention window.
ALTER TABLE "DeviceLogBundle" ADD CONSTRAINT "DeviceLogBundle_connectionEventId_fkey" FOREIGN KEY ("connectionEventId") REFERENCES "DeviceConnectionEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
