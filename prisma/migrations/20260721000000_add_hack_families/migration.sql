-- CreateTable: HackFamily — groups different VERSIONS of the same hack
-- (same name, same platform) so shared fields can be kept in sync and the
-- versions can be browsed/switched between together. See the comment above
-- the HackFamily model in schema.prisma for why this is separate from
-- GameMapping.
CREATE TABLE "HackFamily" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "author" TEXT,
    "releaseYear" INTEGER,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HackFamily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HackFamily_nameKey_platform_key" ON "HackFamily"("nameKey", "platform");

-- CreateIndex
CREATE INDEX "HackFamily_platform_idx" ON "HackFamily"("platform");

-- AlterTable: Submission — link to its HackFamily. Nullable: existing rows
-- stay NULL until the backfill (POST /api/admin/hack-families/backfill) is
-- run; every new submission from here on gets one assigned at creation.
ALTER TABLE "Submission" ADD COLUMN "hackFamilyId" TEXT;

-- CreateIndex
CREATE INDEX "Submission_hackFamilyId_idx" ON "Submission"("hackFamilyId");

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_hackFamilyId_fkey" FOREIGN KEY ("hackFamilyId") REFERENCES "HackFamily"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: ChangeRequest — carries the requester's intent on whether an
-- approved shared-field change (hackName/author/releaseYear/description/tags)
-- should fan out to every other version of the hack, or apply to just this
-- submission. Defaults to true to match "these should match unless told
-- otherwise".
ALTER TABLE "ChangeRequest" ADD COLUMN "applyToAllVersions" BOOLEAN NOT NULL DEFAULT true;
