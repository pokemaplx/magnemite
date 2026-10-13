-- A MITM config carried by one rollout, overriding the device group's.
--
-- The same shape the hooks on this table already have: null means "fall back
-- to the group", which is what every existing row gets and what every rollout
-- that does not override one keeps.
--
-- TEXT and not VARCHAR, for the reason DeviceGroup.mitmConfig is: a bare
-- String is VARCHAR(191) here, and an Aegis config is longer than that.
ALTER TABLE `Rollout`
  ADD COLUMN `mitmConfig` TEXT NULL;
