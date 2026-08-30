-- AlterTable: ChangeRequest — proposed hack-family reassignment, nullable
-- (null = no family change proposed at all; a present value with id: null
-- explicitly proposes detaching the submission from any family — same
-- null-vs-present-empty-ish distinction already used for proposedTags,
-- see that column's comment in schema.prisma).
ALTER TABLE "ChangeRequest" ADD COLUMN "proposedFamily" JSONB;
