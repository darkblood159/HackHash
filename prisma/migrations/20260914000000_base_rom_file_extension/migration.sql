-- Nullable, purely additive. Existing BaseRom rows have no known file
-- extension (they predate this column, or came from a DAT import that
-- never had an original filename to derive one from) and simply stay
-- NULL until someone re-submits a matching hash or an admin sets it by
-- hand via POST /api/admin/base-roms/[id]/edit. Safe to run at any time,
-- no backfill, no data touched on any existing row.
ALTER TABLE "BaseRom" ADD COLUMN "fileExtension" TEXT;
