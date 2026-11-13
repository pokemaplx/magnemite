-- What re-running the bootstrap on a machine last reported.
--
-- Null on every existing row, which is the truth: no machine has ever been
-- asked, because until now nothing could ask.
ALTER TABLE "RedroidHost" ADD COLUMN "bootstrapSteps" JSONB;
ALTER TABLE "RedroidHost" ADD COLUMN "bootstrapRanAt" TIMESTAMP(3);
ALTER TABLE "RedroidHost" ADD COLUMN "bootstrapOk" BOOLEAN;
