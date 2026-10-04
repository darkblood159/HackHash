// src/lib/syncConfig.ts
//
// Every tunable for the automatic Hasheous sync, in one import-free file so
// syncScheduler.ts (which enforces them), the admin status API and the admin
// page (which both DISPLAY them) can never drift apart. Import-free on
// purpose — the admin page is a client component and must not pull Prisma in
// through a server-only module just to read a number.

/** How often the background pull runs (also once, 15s after boot). */
export const PULL_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** How often the background push runs. */
export const PUSH_INTERVAL_MS = 30 * 60 * 1000;

/** Max entries "needing a first sync / re-check" handled per pull cycle. */
export const PULL_BATCH = 200;
/** Max already-synced entries re-checked per pull cycle (the refresh tier). */
export const REFRESH_BATCH = 150;
export const PUSH_BATCH = 50;

export const PULL_DELAY_MS = 800;
export const PUSH_DELAY_MS = 500;

/**
 * An entry Hasheous has no answer for yet (not found / never synced) is asked
 * about again at most this often. Asking more often is pointless: a hash can
 * only start matching after Hasheous imports a DAT that contains it, and
 * Hasheous itself caches a lookup result for up to 5 days (its own code
 * writes the cache for hits and misses alike and never clears it on DAT
 * import), so hammering it every cycle just burns requests.
 */
export const NOT_FOUND_RECHECK_MS = 24 * 60 * 60 * 1000;

/**
 * An entry that already synced successfully is re-checked this often (fill-
 * only, never overwrites or clears anything) so IDs Hasheous adds later —
 * e.g. an IGDB or RetroAchievements match it hadn't made yet when we first
 * pulled — are picked up without anyone clicking anything.
 */
export const SYNCED_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

/** Stop a pull cycle after this many lookups IN A ROW fail (Hasheous down). */
export const MAX_CONSECUTIVE_LOOKUP_ERRORS = 8;
