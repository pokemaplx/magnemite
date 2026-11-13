-- Better Auth 1.7.3 stopped writing `account.issuer`, which 1.7.0–1.7.2 had
-- made required, and refuses to start while it is still NOT NULL: every
-- sign-in would otherwise fail on the next account insert. Accounts are found
-- by (providerId, accountId) again, so the unique index on (issuer, accountId)
-- goes with it.
--
-- Relaxed rather than dropped, so a hub or dashboard still running the old
-- build during the deploy — which selects and writes the column — keeps
-- working until it is replaced.
--
-- The index goes now rather than with the column later: MySQL and MariaDB
-- drop a column out of a composite index instead of dropping the index, which
-- would leave a unique constraint on `accountId` alone.

-- DropIndex
DROP INDEX `account_issuer_accountId_key` ON `account`;

-- AlterTable
ALTER TABLE `account` MODIFY `issuer` VARCHAR(191) NULL;
