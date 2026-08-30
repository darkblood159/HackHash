-- This migration REPLACES the free-text baseRomName/baseRomCrc32/baseRomMd5/
-- baseRomSha1 columns added in 20260725000000_baserom_and_proposed_tags with
-- a proper, hash-verified, admin-approvable BaseRom entity — that earlier
-- design (four plain strings on Submission) was superseded before it was
-- ever deployed, in favor of a shared/deduplicated/approval-gated model.
-- Uses "IF EXISTS" on the drops specifically because it's genuinely unknown
-- whether that earlier migration was ever run against the live database —
-- this makes the migration safe to apply either way, rather than assuming
-- one or the other.
ALTER TABLE "Submission" DROP COLUMN IF EXISTS "baseRomName";
ALTER TABLE "Submission" DROP COLUMN IF EXISTS "baseRomCrc32";
ALTER TABLE "Submission" DROP COLUMN IF EXISTS "baseRomMd5";
ALTER TABLE "Submission" DROP COLUMN IF EXISTS "baseRomSha1";

-- CreateEnum
CREATE TYPE "BaseRomStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "BaseRom" (
    "id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "name" TEXT NOT NULL,
    "crc32" TEXT NOT NULL,
    "md5" TEXT NOT NULL,
    "sha1" TEXT NOT NULL,
    "status" "BaseRomStatus" NOT NULL DEFAULT 'PENDING',
    "submittedById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BaseRom_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BaseRom_sha1_key" ON "BaseRom"("sha1");

-- CreateIndex
CREATE INDEX "BaseRom_platform_idx" ON "BaseRom"("platform");

-- CreateIndex
CREATE INDEX "BaseRom_status_idx" ON "BaseRom"("status");

-- AddForeignKey
ALTER TABLE "BaseRom" ADD CONSTRAINT "BaseRom_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BaseRom" ADD CONSTRAINT "BaseRom_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: Submission — required at the application level (form + API
-- validation), nullable here only so pre-existing rows from before this
-- system existed don't need a fabricated value.
ALTER TABLE "Submission" ADD COLUMN "baseRomId" TEXT;

-- CreateIndex
CREATE INDEX "Submission_baseRomId_idx" ON "Submission"("baseRomId");

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_baseRomId_fkey" FOREIGN KEY ("baseRomId") REFERENCES "BaseRom"("id") ON DELETE SET NULL ON UPDATE CASCADE;
