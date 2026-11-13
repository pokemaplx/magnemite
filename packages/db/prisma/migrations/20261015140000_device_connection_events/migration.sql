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
ALTER TABLE "Device" ADD COLUMN "bootedAt" TIMESTAMP(3);
ALTER TABLE "Device" ADD COLUMN "agentStartedAt" TIMESTAMP(3);

CREATE TYPE "DeviceConnectionCause" AS ENUM ('HUB_RESTART', 'REPLACED', 'DEVICE_DELETED', 'TERMINATED_BY_HUB', 'LINK_LOST', 'AGENT_RESTART', 'REBOOT', 'HEARTBEAT_STALL');

CREATE TABLE "DeviceConnectionEvent" (
    "id" SERIAL NOT NULL,
    "deviceId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "cause" "DeviceConnectionCause",
    "closeCode" INTEGER,
    "closeReason" TEXT,
    "hubRestarted" BOOLEAN NOT NULL DEFAULT false,
    "uptimeBefore" INTEGER,
    "bootedAtBefore" TIMESTAMP(3),
    "agentStartedBefore" TIMESTAMP(3),
    "agentVersionBefore" TEXT,
    "uptimeAfter" INTEGER,
    "bootedAtAfter" TIMESTAMP(3),
    "agentStartedAfter" TIMESTAMP(3),
    "agentVersionAfter" TEXT,
    "bootReason" TEXT,
    "sessionAfter" TEXT,

    CONSTRAINT "DeviceConnectionEvent_pkey" PRIMARY KEY ("id")
);

-- The card's and the drill-down's query: one box, one window.
CREATE INDEX "DeviceConnectionEvent_deviceId_startedAt_idx" ON "DeviceConnectionEvent"("deviceId", "startedAt");

-- The prune's, which is fleet-wide and has no device to narrow by.
CREATE INDEX "DeviceConnectionEvent_startedAt_idx" ON "DeviceConnectionEvent"("startedAt");

-- CASCADE: an episode is a fact about a box, and a box that is gone has no
-- history worth keeping half of.
ALTER TABLE "DeviceConnectionEvent" ADD CONSTRAINT "DeviceConnectionEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
