-- AlterTable: Submission — the stored patch file's location inside patch
-- storage, relative to the storage root (Platform/base ROM/hack/file). NULL =
-- the file is still in the old flat layout and is found via patchSha1 +
-- patchStoredSlug exactly as before. Purely additive: one nullable column, no
-- data change. The admin "Organize patch files" tool fills it in as it moves
-- existing files into folders. See src/lib/patchStorage.ts and
-- src/lib/patchOrganize.ts.
ALTER TABLE "Submission" ADD COLUMN "patchStoredPath" TEXT;
