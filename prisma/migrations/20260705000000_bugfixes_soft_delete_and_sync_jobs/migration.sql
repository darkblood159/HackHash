-- AlterTable: GameMapping — IGDB slug for working game-page links
ALTER TABLE "GameMapping" ADD COLUMN "igdbSlug" TEXT;

-- AlterTable: Submission — soft delete, separate from review `status`
ALTER TABLE "Submission" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Submission" ADD COLUMN "deletedById" TEXT;

-- CreateIndex
CREATE INDEX "Submission_deletedAt_idx" ON "Submission"("deletedAt");

-- CreateEnum
CREATE TYPE "SyncDirection" AS ENUM ('PULL', 'PUSH');
CREATE TYPE "SyncJobStatus" AS ENUM ('RUNNING', 'DONE', 'ERROR');
CREATE TYPE "SyncTrigger" AS ENUM ('MANUAL', 'SCHEDULER');

-- CreateTable
CREATE TABLE "SyncJob" (
    "id" TEXT NOT NULL,
    "direction" "SyncDirection" NOT NULL,
    "env" TEXT NOT NULL,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'RUNNING',
    "triggeredBy" "SyncTrigger" NOT NULL,
    "userId" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "found" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "notFound" INTEGER NOT NULL DEFAULT 0,
    "pushed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "SyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SyncJob_startedAt_idx" ON "SyncJob"("startedAt");
CREATE INDEX "SyncJob_direction_idx" ON "SyncJob"("direction");
