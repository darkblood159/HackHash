-- Bulk submit batches: a handle that groups the submissions one "submit
-- several versions at once" session created, so they can be seen together
-- and undone together (modeled on DatImport). Purely additive — one new
-- table, one new nullable column, one index, one foreign key. Nothing is
-- transformed or backfilled on any existing row: every pre-existing
-- Submission simply has batchId NULL, which is also the permanent, normal
-- state for any submission made one at a time. Nothing in the app reads or
-- writes this yet (the bulk flow that does lands in a later change), so
-- applying it early is safe.

-- CreateTable
CREATE TABLE "SubmissionBatch" (
    "id" TEXT NOT NULL,
    "submittedById" TEXT NOT NULL,
    "hackName" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "reversed" BOOLEAN NOT NULL DEFAULT false,
    "reversedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubmissionBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubmissionBatch_submittedById_createdAt_idx" ON "SubmissionBatch"("submittedById", "createdAt");

-- AlterTable
ALTER TABLE "Submission" ADD COLUMN "batchId" TEXT;

-- CreateIndex
CREATE INDEX "Submission_batchId_idx" ON "Submission"("batchId");

-- AddForeignKey: removing a batch record unlinks its submissions rather than
-- blocking the delete (the column is optional by design, same as
-- datImportId / franchiseId / authorId).
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "SubmissionBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
