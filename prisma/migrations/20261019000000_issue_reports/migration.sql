-- "Report issue" on entries (replaces the Report-as-duplicate button; DuplicateReport is untouched).
-- Purely additive: two enums, one table, three indexes, four foreign keys. No existing row is read or changed.

-- CreateEnum
CREATE TYPE "IssueType" AS ENUM ('BROKEN_LINK', 'PATCH_MISSING', 'PATCH_WONT_APPLY', 'GAME_BROKEN', 'WRONG_INFO', 'HASH_MISMATCH', 'DUPLICATE', 'INAPPROPRIATE', 'OTHER');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "IssueReport" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "IssueType" NOT NULL,
    "comment" TEXT,
    "duplicateOfId" TEXT,
    "status" "IssueStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssueReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IssueReport_status_createdAt_idx" ON "IssueReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "IssueReport_submissionId_idx" ON "IssueReport"("submissionId");

-- CreateIndex
CREATE INDEX "IssueReport_userId_idx" ON "IssueReport"("userId");

-- AddForeignKey
ALTER TABLE "IssueReport" ADD CONSTRAINT "IssueReport_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueReport" ADD CONSTRAINT "IssueReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueReport" ADD CONSTRAINT "IssueReport_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "Submission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueReport" ADD CONSTRAINT "IssueReport_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
