-- A MITM config carried by one rollout, overriding the device group's.
--
-- The same shape the hooks on this table already have: null means "fall back
-- to the group", which is what every existing row gets and what every rollout
-- that does not override one keeps.
ALTER TABLE "Rollout" ADD COLUMN "mitmConfig" TEXT;
