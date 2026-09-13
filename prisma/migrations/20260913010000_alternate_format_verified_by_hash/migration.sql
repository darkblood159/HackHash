-- Purely additive: one new column with a default, so every existing row
-- gets `false` automatically. Nothing existing changes shape or meaning.

-- AlterTable
ALTER TABLE "AlternateFormat" ADD COLUMN "verifiedByHash" BOOLEAN NOT NULL DEFAULT false;
