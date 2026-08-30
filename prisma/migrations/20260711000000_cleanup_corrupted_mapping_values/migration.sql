-- Data cleanup: a since-fixed bug in extractMappings() (src/lib/hasheous.ts)
-- could store the literal text "[object Object]" instead of a real ID, when
-- a Hasheous signature entry didn't have the id/signatureId field this code
-- expected. The bug itself was fixed in an earlier session — this cleans up
-- any row that got corrupted by it BEFORE that fix shipped, since the fix
-- only prevents new occurrences, it doesn't retroactively repair old ones.
--
-- Any row touched here also gets hasheousSyncStatus reset to 'error', which
-- puts it back into the pool the background scheduler re-pulls automatically
-- (see syncScheduler.ts) — so the cleared field gets a chance to be
-- correctly re-populated using the now-fixed extraction logic, without any
-- manual action needed beyond running this migration.
UPDATE "GameMapping"
SET
  "igdbId" = CASE WHEN "igdbId" ~ '^\[object [A-Za-z]*\]$' THEN NULL ELSE "igdbId" END,
  "theGamesDBId" = CASE WHEN "theGamesDBId" ~ '^\[object [A-Za-z]*\]$' THEN NULL ELSE "theGamesDBId" END,
  "giantBombId" = CASE WHEN "giantBombId" ~ '^\[object [A-Za-z]*\]$' THEN NULL ELSE "giantBombId" END,
  "launchboxId" = CASE WHEN "launchboxId" ~ '^\[object [A-Za-z]*\]$' THEN NULL ELSE "launchboxId" END,
  "screenScraperId" = CASE WHEN "screenScraperId" ~ '^\[object [A-Za-z]*\]$' THEN NULL ELSE "screenScraperId" END,
  "steamGridDBId" = CASE WHEN "steamGridDBId" ~ '^\[object [A-Za-z]*\]$' THEN NULL ELSE "steamGridDBId" END,
  "retroAchievementsId" = CASE WHEN "retroAchievementsId" ~ '^\[object [A-Za-z]*\]$' THEN NULL ELSE "retroAchievementsId" END,
  "steamId" = CASE WHEN "steamId" ~ '^\[object [A-Za-z]*\]$' THEN NULL ELSE "steamId" END,
  "gogId" = CASE WHEN "gogId" ~ '^\[object [A-Za-z]*\]$' THEN NULL ELSE "gogId" END,
  "epicGamesId" = CASE WHEN "epicGamesId" ~ '^\[object [A-Za-z]*\]$' THEN NULL ELSE "epicGamesId" END,
  "wikipediaUrl" = CASE WHEN "wikipediaUrl" ~ '^\[object [A-Za-z]*\]$' THEN NULL ELSE "wikipediaUrl" END,
  "hasheousSyncStatus" = 'error',
  "hasheousSyncError" = 'Corrupted value cleaned up (pre-dated a fix to the Hasheous extraction logic) — will re-sync automatically'
WHERE
  "igdbId" ~ '^\[object [A-Za-z]*\]$'
  OR "theGamesDBId" ~ '^\[object [A-Za-z]*\]$'
  OR "giantBombId" ~ '^\[object [A-Za-z]*\]$'
  OR "launchboxId" ~ '^\[object [A-Za-z]*\]$'
  OR "screenScraperId" ~ '^\[object [A-Za-z]*\]$'
  OR "steamGridDBId" ~ '^\[object [A-Za-z]*\]$'
  OR "retroAchievementsId" ~ '^\[object [A-Za-z]*\]$'
  OR "steamId" ~ '^\[object [A-Za-z]*\]$'
  OR "gogId" ~ '^\[object [A-Za-z]*\]$'
  OR "epicGamesId" ~ '^\[object [A-Za-z]*\]$'
  OR "wikipediaUrl" ~ '^\[object [A-Za-z]*\]$';
