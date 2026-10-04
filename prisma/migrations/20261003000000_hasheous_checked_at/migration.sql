-- Hasheous pull rotation: remember when each submission's hash last got a
-- DEFINITIVE answer from Hasheous (found, or a real "not found") so the
-- background pull can work through every entry in turn instead of asking
-- about the same newest 200 unresolved ones every cycle (which starved
-- everything behind them whenever 200+ were persistently unmatched).
--
-- Purely additive — one new NULLABLE column, no default, no index, no
-- backfill. Every existing row is simply NULL ("never checked"), which the
-- scheduler treats as "due now" and drains over the following cycles.
-- Nothing else reads it.

-- AlterTable
ALTER TABLE "Submission" ADD COLUMN "hasheousCheckedAt" TIMESTAMP(3);
