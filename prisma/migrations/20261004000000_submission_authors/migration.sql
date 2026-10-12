-- Multiple authors per hack: Submission.authorId (one nullable link) becomes
-- the SubmissionAuthor join table (ordered, many per submission).
--
-- Unlike most migrations in this project this one is NOT purely additive: it
-- creates the table, COPIES every existing link into it, then drops the old
-- column, in that order, so the data is never only in the column being
-- dropped. Prisma sends the file as one multi-statement query, which
-- Postgres runs as a single implicit transaction (not verified through
-- Prisma's own engine from the sandbox - only by replaying the file in
-- psql). Rolling the app back to an image from before this change needs a
-- database restore (the column is gone), so take a backup (Admin -> Backup)
-- before deploying.
--
-- Submission.author (the plain-text display cache) is NOT touched: with one
-- linked author it already equals that author's name, which is exactly what
-- the cache must hold for a one-author list. Submissions with free-text
-- author and no link get no rows, same as before.

-- CreateTable
CREATE TABLE "SubmissionAuthor" (
    "submissionId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SubmissionAuthor_pkey" PRIMARY KEY ("submissionId","authorId")
);

-- CreateIndex
CREATE INDEX "SubmissionAuthor_authorId_idx" ON "SubmissionAuthor"("authorId");

-- AddForeignKey
ALTER TABLE "SubmissionAuthor" ADD CONSTRAINT "SubmissionAuthor_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionAuthor" ADD CONSTRAINT "SubmissionAuthor_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Author"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Copy every existing single link in as the first (and only) author.
INSERT INTO "SubmissionAuthor" ("submissionId", "authorId", "position")
SELECT "id", "authorId", 0 FROM "Submission" WHERE "authorId" IS NOT NULL;

-- Drop the old single-author link.
ALTER TABLE "Submission" DROP CONSTRAINT "Submission_authorId_fkey";
DROP INDEX "Submission_authorId_idx";
ALTER TABLE "Submission" DROP COLUMN "authorId";
