-- Authors: a shared, deduplicated list of the people/teams credited with
-- hacks — same PENDING/APPROVED, merge-not-reject shape as Franchise.
-- Purely additive — one new enum, one new table, two new nullable columns,
-- one new JSON column on ChangeRequest. Nothing is transformed or
-- backfilled on any existing row; every pre-existing Submission simply has
-- no linked author (authorId NULL) until one is assigned — its existing
-- free-text `author` string is untouched and keeps working exactly as
-- before (search, DAT export, the /submissions?author=... filter link,
-- HackFamily's shared-field propagation all still read that column
-- directly; see the long comment on Submission.author in
-- prisma/schema.prisma for why it stays rather than being replaced).

-- CreateEnum
CREATE TYPE "AuthorStatus" AS ENUM ('PENDING', 'APPROVED');

-- CreateTable
CREATE TABLE "Author" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "status" "AuthorStatus" NOT NULL DEFAULT 'PENDING',
    "submittedById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Author_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Author_nameKey_key" ON "Author"("nameKey");

-- CreateIndex
CREATE INDEX "Author_status_idx" ON "Author"("status");

-- AlterTable: Submission — optional link to the Author list. Named
-- authorId/authorRef (not authorId/author, the franchiseId/franchise
-- convention) purely because `author` was already taken by the pre-
-- existing free-text column — see that column's own comment in
-- prisma/schema.prisma.
ALTER TABLE "Submission" ADD COLUMN "authorId" TEXT;

-- CreateIndex
CREATE INDEX "Submission_authorId_idx" ON "Submission"("authorId");

-- AddForeignKey: removing an author unlinks its submissions rather than
-- blocking the delete (the column is optional by design, same as
-- franchiseId).
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Author"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: ChangeRequest — proposed author change, nullable
-- (null/absent = no author change proposed; { id: null } = propose
-- removing it).
ALTER TABLE "ChangeRequest" ADD COLUMN "proposedAuthor" JSONB;
