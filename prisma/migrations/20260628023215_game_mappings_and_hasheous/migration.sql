-- AlterTable
ALTER TABLE "Submission" ADD COLUMN     "gameMappingId" TEXT;

-- CreateTable
CREATE TABLE "GameMapping" (
    "id" TEXT NOT NULL,
    "canonicalName" TEXT,
    "canonicalReleaseDate" TIMESTAMP(3),
    "canonicalDescription" TEXT,
    "epicGamesId" TEXT,
    "gogId" TEXT,
    "giantBombId" TEXT,
    "igdbId" TEXT,
    "launchboxId" TEXT,
    "retroAchievementsId" TEXT,
    "screenScraperId" TEXT,
    "steamId" TEXT,
    "steamGridDBId" TEXT,
    "theGamesDBId" TEXT,
    "wikipediaUrl" TEXT,
    "hasheousSyncedAt" TIMESTAMP(3),
    "hasheousSyncStatus" TEXT,
    "hasheousSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GameMapping_igdbId_idx" ON "GameMapping"("igdbId");

-- CreateIndex
CREATE INDEX "GameMapping_theGamesDBId_idx" ON "GameMapping"("theGamesDBId");

-- CreateIndex
CREATE INDEX "GameMapping_steamId_idx" ON "GameMapping"("steamId");

-- CreateIndex
CREATE INDEX "GameMapping_hasheousSyncStatus_idx" ON "GameMapping"("hasheousSyncStatus");

-- CreateIndex
CREATE INDEX "Submission_gameMappingId_idx" ON "Submission"("gameMappingId");

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_gameMappingId_fkey" FOREIGN KEY ("gameMappingId") REFERENCES "GameMapping"("id") ON DELETE SET NULL ON UPDATE CASCADE;
