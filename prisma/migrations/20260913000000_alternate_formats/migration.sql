-- Purely additive: one new enum, one new table, two new FKs back to User.
-- Nothing on Submission itself changes — its own crc32/md5/sha1/filename
-- columns remain "the original format" untouched, exactly as designed (see
-- the AlternateFormat model's own comment in schema.prisma for the full
-- reasoning). Safe to run at any time; nothing existing reads from or
-- depends on this table yet.

-- CreateEnum
CREATE TYPE "AlternateFormatStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "AlternateFormat" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "crc32" TEXT NOT NULL,
    "md5" TEXT NOT NULL,
    "sha1" TEXT NOT NULL,
    "status" "AlternateFormatStatus" NOT NULL DEFAULT 'PENDING',
    "addedById" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlternateFormat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AlternateFormat_submissionId_sha1_key" ON "AlternateFormat"("submissionId", "sha1");

-- CreateIndex
CREATE INDEX "AlternateFormat_submissionId_idx" ON "AlternateFormat"("submissionId");

-- CreateIndex
CREATE INDEX "AlternateFormat_status_idx" ON "AlternateFormat"("status");

-- AddForeignKey
ALTER TABLE "AlternateFormat" ADD CONSTRAINT "AlternateFormat_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlternateFormat" ADD CONSTRAINT "AlternateFormat_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlternateFormat" ADD CONSTRAINT "AlternateFormat_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
