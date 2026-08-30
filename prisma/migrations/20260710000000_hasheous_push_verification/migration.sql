-- AlterTable: GameMapping — push verification tracking, separate from the
-- existing pull-sync fields (hasheousSyncStatus etc). See schema.prisma
-- comment on these fields for why they're tracked independently.
ALTER TABLE "GameMapping" ADD COLUMN "hasheousPushedAt" TIMESTAMP(3);
ALTER TABLE "GameMapping" ADD COLUMN "hasheousPushedFields" JSONB;
ALTER TABLE "GameMapping" ADD COLUMN "hasheousPushStatus" TEXT;
ALTER TABLE "GameMapping" ADD COLUMN "hasheousPushVerifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "GameMapping_hasheousPushStatus_idx" ON "GameMapping"("hasheousPushStatus");
