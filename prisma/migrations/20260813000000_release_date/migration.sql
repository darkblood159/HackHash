-- AlterTable: Submission, HackFamily — add releaseDate (a real
-- month/day/year calendar date, DATE type so there's no time-of-day/
-- timezone component to get wrong) alongside the existing releaseYear
-- column on both tables. Deliberately ADDITIVE ONLY: releaseYear is left
-- exactly as-is on every existing row, nothing is backfilled or derived
-- here. Existing submissions that only ever recorded a year keep showing
-- just that year — inventing a fake month/day for them (e.g. defaulting
-- to January 1) would display false precision that was never actually
-- known, so this migration deliberately does not attempt it. Going
-- forward, releaseDate is populated whenever a full date is actually
-- provided, and releaseYear is kept in sync automatically at write time
-- (see resolveReleaseFields() in src/lib/hackFamily.ts) — releaseYear
-- alone continues to mean "year known, exact date not."
ALTER TABLE "Submission" ADD COLUMN "releaseDate" DATE;
ALTER TABLE "HackFamily" ADD COLUMN "releaseDate" DATE;
