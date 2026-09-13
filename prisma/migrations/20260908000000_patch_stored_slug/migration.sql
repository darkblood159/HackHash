-- AlterTable: Submission — the human-readable slug (from hackName +
-- version) baked into a stored patch file's actual filename on disk
-- alongside its hash, so a patch-storage folder is browsable by a human
-- rather than just a list of bare hashes. See src/lib/patchStorage.ts's
-- buildPatchDisplaySlug and CLAUDE_HANDOFF.txt section 2au. Persisted
-- (not recomputed on read) so a later hackName/version edit can never
-- make an already-uploaded file unfindable.
ALTER TABLE "Submission" ADD COLUMN "patchStoredSlug" TEXT;
