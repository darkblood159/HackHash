// src/lib/mappingFields.ts
//
// Single source of truth for "which fields belong to GameMapping" and how to
// normalize a raw value (ID or pasted URL) into a clean stored ID.
//
// This used to only exist client-side in MappingsSection.tsx (for the submit
// form). That meant anything else that could write a mapping value —
// Hasheous auto-pull, admin direct edit, change requests — stored whatever
// raw value it got, which is exactly how GiantBomb/LaunchBox ended up with
// full URLs in the DB (see extractMappings() in hasheous.ts). Everything
// that writes a GameMapping field now runs the value through here first.

export const MAPPING_FIELD_KEYS = [
  'igdbId',
  'theGamesDBId',
  'launchboxId',
  'steamGridDBId',
  'retroAchievementsId',
  'steamId',
  'gogId',
  'giantBombId',
  'screenScraperId',
  'epicGamesId',
  'wikipediaUrl',
] as const;

export type MappingFieldKey = (typeof MAPPING_FIELD_KEYS)[number];

export function isMappingFieldKey(key: string): key is MappingFieldKey {
  return (MAPPING_FIELD_KEYS as readonly string[]).includes(key);
}

/**
 * Detects values that are the literal text of a stringified JS object
 * (e.g. "[object Object]") rather than a real ID — the signature of the
 * since-fixed extractMappings() bug where a signature object without an
 * id/signatureId field got passed to String() directly. Used defensively
 * at display/export time (MappingsDisplay.tsx, dat-generator.ts) so this
 * exact class of corruption can never be shown to a user again, even if
 * some other not-yet-found path produces it, and to find/clean up existing
 * rows already corrupted by the original bug (see the cleanup migration).
 */
export function isCorruptedMappingValue(value: string): boolean {
  return /^\[object [A-Za-z]*\]$/.test(value.trim());
}

// Mirrors the strip() regexes in MappingsSection.tsx. IGDB is deliberately
// absent — igdb.com URLs contain a text slug, not the numeric ID, so there's
// nothing safe to extract from an IGDB URL. wikipediaUrl is a URL by design,
// so it's left alone.
const STRIPPERS: Partial<Record<MappingFieldKey, (v: string) => string>> = {
  theGamesDBId: (v) => v.match(/[?&]id=(\d+)/)?.[1] ?? v,
  // LaunchBox has TWO real URL shapes for the same game — the short
  // redirect-style permalink (/games/dbid/{id}) AND what actually shows in
  // the address bar when browsing their site (/games/details/{id}-{slug}).
  // Only the first was recognized before (found live, Aug 14 — a pasted or
  // pull-extracted /details/ URL fell through this regex entirely and got
  // stored as a full URL, which the display template then wrapped a SECOND
  // time into a doubled link).
  launchboxId: (v) => v.match(/\/(?:dbid|details)\/(\d+)/)?.[1] ?? v,
  steamGridDBId: (v) => v.match(/\/game\/(\d+)/)?.[1] ?? v,
  retroAchievementsId: (v) => v.match(/\/game\/(\d+)/)?.[1] ?? v,
  steamId: (v) => v.match(/\/app\/(\d+)/)?.[1] ?? v,
  gogId: (v) => v.match(/gog\.com\/game\/([^/?#]+)/)?.[1] ?? v,
  // Normalizes to the BARE numeric id, discarding GiantBomb's "3030-"
  // object-type prefix (3030 = their internal type code for a Game,
  // confirmed against Hasheous's own LinkBuilder source — see
  // MappingsDisplay.tsx's giantBombId template, which adds this same prefix
  // back on for display). Found live, Aug 14: the OLD stripper kept the
  // prefix (e.g. "3030-44054"), but a fresh Hasheous pull extracts the bare
  // id directly ("44054") — the same field ending up in two different
  // formats depending on whether it was pasted by hand or pulled meant the
  // display template (written assuming bare storage, to match pull) would
  // double the prefix for any pre-existing hand-entered value, and a push
  // built from a prefixed value would likely be rejected by Hasheous
  // outright (their own FixMatch expects the same bare id their Lookup
  // returns). Second pattern below handles a bare "3030-44054" with no URL
  // wrapper at all, for the same reason.
  giantBombId: (v) =>
    v.match(/giantbomb\.com\/[^/]+\/\d+-(\d+)/)?.[1] ??
    v.match(/^\d+-(\d+)$/)?.[1] ??
    v,
  epicGamesId: (v) => v.match(/epicgames\.com\/store\/[^/]+\/[^/]+\/([^/?#]+)/)?.[1] ?? v,
};

/**
 * Normalize a raw mapping value (which may be a clean ID or a pasted/scraped
 * URL) down to the clean stored form. Safe to call on already-clean values —
 * if the regex doesn't match, the original value passes through unchanged.
 */
export function stripMappingValue(key: MappingFieldKey, raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  // "[object Object]" and similar — not a real ID, never was; treat as empty
  // rather than storing/displaying/exporting it. See isCorruptedMappingValue.
  if (isCorruptedMappingValue(trimmed)) return '';
  const strip = STRIPPERS[key];
  return strip ? strip(trimmed) : trimmed;
}

/**
 * Given a partial object of { fieldKey: rawValue }, return a new object with
 * every recognized mapping field stripped/normalized. Non-mapping keys and
 * null/undefined values pass through untouched.
 */
export function stripMappingValues<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = { ...input };
  for (const key of Object.keys(out)) {
    if (isMappingFieldKey(key) && typeof out[key] === 'string' && out[key]) {
      out[key] = stripMappingValue(key, out[key] as string);
    }
  }
  return out as T;
}
