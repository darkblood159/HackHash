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

// ─── Post-ingest refresh wave (Oct 19) ────────────────────────────────────
//
// Hasheous re-imports HackHash's own DAT export on a fixed 7-day interval
// (hasheous PR #605: `HackHash.DownloadManager`, Interval = 10080 min, runs
// from the last run's start). The old 7-day per-row refresh tier ran on each
// row's OWN clock, so it was never tied to that import and could only cover
// REFRESH_BATCH x (7d / 6h) = 600 entries a week. The wave below ties it to the
// import instead: once Hasheous has imported the DAT AND its daily metadata
// match run has processed it, every already-synced entry is re-checked once
// (fill-only, like the routine refresh).
//
// The signal is Hasheous's own PUBLIC (anonymous) task list — the same one its
// status page shows — so no weekday/time is hard-coded here: if Hasheous moves
// the schedule, this follows.

/** How often we ask Hasheous's task list whether a new import happened (one cheap GET). */
export const WAVE_CHECK_MS = 60 * 60 * 1000;

/**
 * After Hasheous's metadata match run finishes, wait this long before the wave
 * starts. Hasheous caches the signature -> game/metadata mapping for up to 6h
 * (HashLookup2 `DataObjectFromSignatureId`), so asking sooner can still be
 * answered from before the match run.
 */
export const WAVE_SETTLE_MS = 6 * 60 * 60 * 1000;

/**
 * If Hasheous's match run never shows up as finished after an import (task
 * list unreadable for that item, disabled, stuck), start the wave anyway this
 * long after the import finished rather than never.
 */
export const WAVE_MAX_WAIT_MS = 3 * 24 * 60 * 60 * 1000;

/** Already-synced entries re-checked per hourly tick WHILE a wave is active. */
export const WAVE_REFRESH_BATCH = 300;

/** Timeout for the one GET against Hasheous's task list. */
export const WAVE_STATUS_TIMEOUT_MS = 15_000;

/** `itemName` of HackHash's import task in Hasheous's task list (its class's full name). */
export const HASHEOUS_INGEST_ITEM_NAME = 'HackHash.DownloadManager';

/** `itemType` of Hasheous's daily metadata-matching task. */
export const HASHEOUS_MATCH_ITEM_TYPE = 'MetadataMatchSearch';
