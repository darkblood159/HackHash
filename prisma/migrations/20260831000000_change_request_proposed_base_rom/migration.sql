-- AlterTable: ChangeRequest — proposed base-rom reassignment, nullable
-- (null/absent = no base-rom change proposed). Unlike proposedFamily, this
-- has no id: null "detach" case — see the column's comment in
-- schema.prisma for why.
ALTER TABLE "ChangeRequest" ADD COLUMN "proposedBaseRom" JSONB;
