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
CREATE TABLE "GroupJoinInstall" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "appVersionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupJoinInstall_pkey" PRIMARY KEY ("id")
);

-- One row per build per group: adding the same build twice is the same
-- instruction, not two.
CREATE UNIQUE INDEX "GroupJoinInstall_groupId_appVersionId_key" ON "GroupJoinInstall"("groupId", "appVersionId");

CREATE INDEX "GroupJoinInstall_appVersionId_idx" ON "GroupJoinInstall"("appVersionId");

-- CASCADE on both sides, unlike the group links elsewhere in this schema,
-- because this row is only an instruction about a pair. A deleted group has no
-- boxes left to join it, and a deleted build cannot be installed -- in either
-- case the instruction is not something to preserve with half of it missing.
ALTER TABLE "GroupJoinInstall" ADD CONSTRAINT "GroupJoinInstall_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "DeviceGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GroupJoinInstall" ADD CONSTRAINT "GroupJoinInstall_appVersionId_fkey" FOREIGN KEY ("appVersionId") REFERENCES "AppVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
