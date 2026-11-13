-- Workers stop being a copy written onto every instance at scale time and
-- become the inheritance the memory ceiling already has:
-- instance ?? machine ?? Settings → redroid.workersPerInstance.
--
-- The rows already here are rewritten into that shape without moving any box
-- that rendered a number: {{device.workers}} resolves to the same value the
-- moment after this runs as the moment before. What changes is later -- a box
-- that carried the fleet's number as a copy now follows it when it changes.

-- AlterTable
ALTER TABLE "RedroidHost" ADD COLUMN "workers" INTEGER;

-- A machine whose present instances all carry one number takes it as its own.
-- The scale form only ever set it machine-wide, so that is every machine with
-- one; instances that disagree can only be somebody's psql, and are left be.
UPDATE "RedroidHost" SET "workers" = s.w
FROM (
  SELECT "hostId", MIN("workers") AS w
  FROM "RedroidInstance"
  WHERE "present" = true AND "workers" IS NOT NULL
  GROUP BY "hostId"
  HAVING MIN("workers") = MAX("workers")
) s
WHERE "RedroidHost"."deviceId" = s."hostId";

-- Its instances stop carrying the copy, and so do the removed ones: bringing
-- one back overwrote its number with the machine's, so the one it kept was
-- never going to be used.
UPDATE "RedroidInstance" SET "workers" = NULL
FROM "RedroidHost" h
WHERE "RedroidInstance"."hostId" = h."deviceId"
  AND ("RedroidInstance"."present" = false OR "RedroidInstance"."workers" = h."workers");

-- And a machine at the fleet-wide number was never told anything else: it was
-- given the default by a form that pre-filled it, so it follows Settings now.
-- 50 when nothing is saved, the default `getRedroidSettings` has.
UPDATE "RedroidHost" SET "workers" = NULL
WHERE "workers" = COALESCE(
  (
    SELECT ("value" #>> '{}')::int
    FROM "Setting"
    WHERE "key" = 'redroid.workersPerInstance' AND ("value" #>> '{}') ~ '^[0-9]+$'
  ),
  50
);
