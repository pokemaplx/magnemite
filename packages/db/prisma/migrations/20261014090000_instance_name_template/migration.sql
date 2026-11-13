-- What a machine's containers are called when they enrol.
--
-- Without a template a Redroid box names itself from what Android reports --
-- the manufacturer and model, identical on every box in the fleet, plus six
-- characters of a minted serial. The template is filled in with {host},
-- {index} and {serial} at enrolment.
--
-- Null on every existing row, which keeps today's behaviour: these are
-- defaults for boxes that have not enrolled yet, and nothing here renames a
-- box that already has a name.
ALTER TABLE "RedroidHost" ADD COLUMN "nameTemplate" TEXT;

-- The same choice, parked on the provisioning run until the machine exists to
-- carry it -- exactly as desiredGroupId is.
ALTER TABLE "RedroidBootstrap" ADD COLUMN "desiredNameTemplate" TEXT;
