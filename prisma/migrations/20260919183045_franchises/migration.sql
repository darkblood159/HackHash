-- Franchises: a shared, deduplicated game-franchise/series entity (Super
-- Mario, Zelda, Pokemon...) hacks can be grouped and filtered under.
-- Purely additive — one new enum, one new table, two new nullable columns.
-- Nothing is transformed or backfilled on any existing row; every
-- pre-existing Submission simply has no franchise (franchiseId NULL) until
-- one is assigned.

-- CreateEnum
CREATE TYPE "FranchiseStatus" AS ENUM ('PENDING', 'APPROVED');

-- CreateTable
CREATE TABLE "Franchise" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "status" "FranchiseStatus" NOT NULL DEFAULT 'PENDING',
    "submittedById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Franchise_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Franchise_nameKey_key" ON "Franchise"("nameKey");

-- CreateIndex
CREATE INDEX "Franchise_status_idx" ON "Franchise"("status");

-- AlterTable: Submission — optional franchise link.
ALTER TABLE "Submission" ADD COLUMN "franchiseId" TEXT;

-- CreateIndex
CREATE INDEX "Submission_franchiseId_idx" ON "Submission"("franchiseId");

-- AddForeignKey: removing a franchise unlinks its submissions rather than
-- blocking the delete (the column is optional by design).
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_franchiseId_fkey" FOREIGN KEY ("franchiseId") REFERENCES "Franchise"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: ChangeRequest — proposed franchise change, nullable
-- (null/absent = no franchise change proposed; { id: null } = propose
-- removing it).
ALTER TABLE "ChangeRequest" ADD COLUMN "proposedFranchise" JSONB;
