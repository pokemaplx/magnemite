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
--
-- VARCHAR(191) because that is what Prisma maps an unannotated String to on
-- this provider, and the two have to agree or every later `migrate diff`
-- reports drift. A template is a few dozen characters; the renderer caps the
-- result at 64 either way.
ALTER TABLE `RedroidHost` ADD COLUMN `nameTemplate` VARCHAR(191) NULL;

-- The same choice, parked on the provisioning run until the machine exists to
-- carry it -- exactly as desiredGroupId is.
ALTER TABLE `RedroidBootstrap` ADD COLUMN `desiredNameTemplate` VARCHAR(191) NULL;
