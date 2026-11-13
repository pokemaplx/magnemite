-- What each Redroid box's MITM config says about its workers, so the hub can
-- rewrite the config by itself when the resolved number moves away from it.

-- AlterTable
ALTER TABLE `RedroidInstance` ADD COLUMN `configWorkers` INTEGER NULL;

-- AlterTable
--
-- The same number for an install in flight, copied onto the instance only
-- when the install succeeds.
ALTER TABLE `Job` ADD COLUMN `configWorkers` INTEGER NULL;

-- Every box already enrolled is taken to be in step with the number it
-- resolves to now, so upgrading rewrites nothing and restarts no scanner. The
-- first change after it is what sets a rewrite going -- which is the feature,
-- and the only moment it should happen.
--
-- The resolution is `instance ?? machine ?? Settings`, with 50 when nothing is
-- saved: the default `getRedroidSettings` has.
UPDATE `RedroidInstance` i
JOIN `RedroidHost` h ON i.`hostId` = h.`deviceId`
SET i.`configWorkers` = COALESCE(
  i.`workers`,
  h.`workers`,
  (
    SELECT CAST(JSON_UNQUOTE(JSON_EXTRACT(`value`, '$')) AS UNSIGNED)
    FROM `Setting`
    WHERE `key` = 'redroid.workersPerInstance'
      AND JSON_UNQUOTE(JSON_EXTRACT(`value`, '$')) REGEXP '^[0-9]+$'
  ),
  50
)
WHERE i.`deviceId` IS NOT NULL;
