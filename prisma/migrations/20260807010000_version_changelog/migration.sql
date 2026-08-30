-- AlterTable: Submission — free-text field for "what changed in this
-- specific version", distinct from the general `description` (which
-- describes the hack overall) and never synced across sibling versions.
ALTER TABLE "Submission" ADD COLUMN "versionChangelog" TEXT;
