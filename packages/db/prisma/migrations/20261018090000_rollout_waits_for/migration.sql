-- A rollout that waits for another.
--
-- What a box joining its group installs in order: the game first, and the MITM
-- only once the game is on the box, because the MITM's config is written with
-- it and its post-install hook is what starts it. Created PENDING alongside
-- the game's, it starts the moment that one has finished with every job a
-- success; a failed game leaves it waiting, and retrying that job releases it.
--
-- SET NULL rather than CASCADE: a waiting rollout is its own record, and losing
-- what it waited for is a reason to look at it, not to delete it.

-- AlterTable
ALTER TABLE "Rollout" ADD COLUMN "waitsForId" TEXT;

-- CreateIndex
CREATE INDEX "Rollout_waitsForId_idx" ON "Rollout"("waitsForId");

-- AddForeignKey
ALTER TABLE "Rollout" ADD CONSTRAINT "Rollout_waitsForId_fkey" FOREIGN KEY ("waitsForId") REFERENCES "Rollout"("id") ON DELETE SET NULL ON UPDATE CASCADE;
