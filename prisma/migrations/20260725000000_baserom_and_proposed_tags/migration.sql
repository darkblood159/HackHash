-- AlterTable: Submission — optional reference to the unpatched source ROM
-- a hack's patch expects (name + up to 3 hashes), separate from the
-- patched ROM's own crc32/md5/sha1 columns which already existed.
ALTER TABLE "Submission" ADD COLUMN "baseRomName" TEXT;
ALTER TABLE "Submission" ADD COLUMN "baseRomCrc32" TEXT;
ALTER TABLE "Submission" ADD COLUMN "baseRomMd5" TEXT;
ALTER TABLE "Submission" ADD COLUMN "baseRomSha1" TEXT;

-- AlterTable: ChangeRequest — proposed tag slugs, nullable (null = no tag
-- change proposed, distinct from [] = explicitly clear all tags).
ALTER TABLE "ChangeRequest" ADD COLUMN "proposedTags" JSONB;
