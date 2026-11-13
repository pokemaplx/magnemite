-- The group a machine's first containers enrol into, chosen when the machine
-- is added rather than afterwards.
--
-- There is no afterwards: provisioning ends by bringing the containers up, and
-- their boxes enrol in the same breath. Until now they all landed in `default`
-- and had to be moved by hand, after the first rollout had already handed them
-- that group's MITM config.
--
-- Null on every existing row, which is the truth: no bootstrap was ever asked.
ALTER TABLE "RedroidBootstrap" ADD COLUMN "desiredGroupId" TEXT;

CREATE INDEX "RedroidBootstrap_desiredGroupId_idx" ON "RedroidBootstrap"("desiredGroupId");

-- SET NULL, matching RedroidHost.defaultGroupId: deleting a group must not
-- take a provisioning run with it.
ALTER TABLE "RedroidBootstrap" ADD CONSTRAINT "RedroidBootstrap_desiredGroupId_fkey" FOREIGN KEY ("desiredGroupId") REFERENCES "DeviceGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
