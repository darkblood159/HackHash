-- CreateTable: DismissedFamilyPair — records an admin's "these are not the
-- same hack" decision on a pair findDuplicateFamilyCandidates() flagged, so
-- it stops being suggested. familyAId is always the lexicographically
-- smaller of the two family ids (enforced in application code, see
-- dismissDuplicatePair in src/lib/hackFamily.ts), so the same pair can't be
-- stored twice in reversed order.
CREATE TABLE "DismissedFamilyPair" (
    "id" TEXT NOT NULL,
    "familyAId" TEXT NOT NULL,
    "familyBId" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissedById" TEXT,

    CONSTRAINT "DismissedFamilyPair_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DismissedFamilyPair_familyAId_familyBId_key" ON "DismissedFamilyPair"("familyAId", "familyBId");

-- AddForeignKey
ALTER TABLE "DismissedFamilyPair" ADD CONSTRAINT "DismissedFamilyPair_familyAId_fkey" FOREIGN KEY ("familyAId") REFERENCES "HackFamily"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DismissedFamilyPair" ADD CONSTRAINT "DismissedFamilyPair_familyBId_fkey" FOREIGN KEY ("familyBId") REFERENCES "HackFamily"("id") ON DELETE CASCADE ON UPDATE CASCADE;
