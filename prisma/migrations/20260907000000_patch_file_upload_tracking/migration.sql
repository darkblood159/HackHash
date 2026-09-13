-- AlterTable: Submission — patch FILE upload tracking, all nullable/additive.
-- The existing patchType/patchFilename/patchSha1 columns are untouched;
-- this trio just records whether/when/by-whom the actual patch bytes were
-- uploaded and stored on disk (see src/lib/patchStorage.ts and POST
-- /api/submissions/[id]/patch). patchUploadedAt IS NULL means "no file
-- attached" — that's the real flag to check, not patchSha1, since
-- patchSha1 can already be filled in via PatchDropzone's hash-only mode
-- with no file ever having been uploaded.
ALTER TABLE "Submission" ADD COLUMN "patchFileSize" INTEGER;
ALTER TABLE "Submission" ADD COLUMN "patchUploadedAt" TIMESTAMP(3);
ALTER TABLE "Submission" ADD COLUMN "patchUploadedById" TEXT;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_patchUploadedById_fkey" FOREIGN KEY ("patchUploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
