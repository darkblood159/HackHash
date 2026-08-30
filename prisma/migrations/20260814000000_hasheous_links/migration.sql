-- AlterTable: GameMapping — adds hasheousLinks, a JSON snapshot of the
-- ready-made per-source links Hasheous computes server-side (Lookup/ByHash's
-- metadata[].link). Purely additive: one new nullable column, nothing
-- transformed on any existing row. See schema.prisma's comment on this field
-- for why it exists (our own hand-rolled per-source URL templates had
-- drifted from Hasheous's real convention for at least GiantBomb).
ALTER TABLE "GameMapping" ADD COLUMN "hasheousLinks" JSONB;
