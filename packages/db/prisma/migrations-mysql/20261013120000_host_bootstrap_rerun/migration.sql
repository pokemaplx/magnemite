-- What re-running the bootstrap on a machine last reported.
--
-- Null on every existing row, which is the truth: no machine has ever been
-- asked, because until now nothing could ask.
--
-- JSON rather than TEXT: Prisma maps Json to JSON here, and the step list is
-- read back as an array rather than parsed by hand.
ALTER TABLE `RedroidHost`
  ADD COLUMN `bootstrapSteps` JSON NULL,
  ADD COLUMN `bootstrapRanAt` DATETIME(3) NULL,
  ADD COLUMN `bootstrapOk` BOOLEAN NULL;
