// src/lib/bulkPairing.ts
//
// The pure (no React, no DOM, no network) logic behind the bulk-submit table:
// putting versions in order, matching patch files to ROM rows, and the
// "does this look right?" heuristics. Kept separate so it can be tested on
// its own, and so none of these rules is written twice.
//
// THE RULE EVERYTHING HERE FOLLOWS: a guess is never presented as a fact.
// pairPatches only auto-pairs when the match is unambiguous, and labels HOW
// it matched ('exact' filename vs 'version' number) so the UI can tell the
// person which pairings were a guess. An ambiguous match is left UNPAIRED for
// the person to choose, never resolved silently.

import { parseRomFilename } from './filenameParser';

// ─── Version ordering ──────────────────────────────────────────────────────

/** "v1.2" and "1.2" are the same version label for comparison purposes. */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v(?:ersion)?\.?\s*/i, '').toLowerCase();
}

/**
 * Natural ordering: 1.2 before 1.10, 1.0 before 1.0a, v2 after 1.9. Used to
 * put rows in the order they'll be created — which matters, because a hack's
 * version chips are ordered by creation time (see submissions/[id]/page.tsx).
 */
export function versionCompare(a: string, b: string): number {
  return normalizeVersion(a).localeCompare(normalizeVersion(b), 'en', { numeric: true, sensitivity: 'base' });
}

// ─── Filename helpers ──────────────────────────────────────────────────────

/** Filename minus its last extension, lowercased, punctuation collapsed to single spaces. */
export function normalizeStem(filename: string): string {
  const idx = filename.lastIndexOf('.');
  const stem = idx > 0 ? filename.slice(0, idx) : filename;
  return stem.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// A bare dotted number as the last token of a name ("Hack 1.2", "1.0.ips").
// Only a FALLBACK after parseRomFilename (which needs a "v" prefix or
// parentheses), and only ever used to suggest a pairing or pre-fill a label,
// both of which the person sees and can change.
const BARE_VERSION = /(?:^|[\s_-])v?(\d+(?:\.\d+)+[a-z]?)$/i;

/** Best-effort version label from a file's name, or undefined. */
export function versionFromFilename(filename: string): string | undefined {
  const parsed = parseRomFilename(filename);
  if (parsed.version) return parsed.version;
  const idx = filename.lastIndexOf('.');
  const stem = (idx > 0 ? filename.slice(0, idx) : filename).replace(/_/g, ' ').trim();
  return stem.match(BARE_VERSION)?.[1];
}

/** Best-effort hack name from a file's name ('' when there isn't one). */
export function hackNameFromFilename(filename: string): string {
  return parseRomFilename(filename).hackName;
}

const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** First letters of each word — "Super Mario World" -> "smw". Needs 2+ words to mean anything. */
const acronym = (s: string) => {
  const w = words(s);
  return w.length >= 2 ? w.map((x) => x[0]).join('') : '';
};

/**
 * Whether a filename's hack name plausibly belongs with the batch's hack
 * name. Deliberately generous — it exists to catch "dropped a file from a
 * different hack" (nothing in common), not to police naming. Abbreviations
 * count ("SMW" for "Super Mario World" is how half of ROM hacking names its
 * files, and a false alarm on every row would defeat the point of bulk).
 * Returns true whenever either side is empty: nothing to compare means
 * nothing to warn about.
 */
export function nameResembles(fromFilename: string, headerName: string): boolean {
  const a = tokens(fromFilename);
  const b = tokens(headerName);
  if (a.length === 0 || b.length === 0) return true;
  if (a.some((t) => b.includes(t))) return true;
  const ja = a.join(''), jb = b.join('');
  if (ja.includes(jb) || jb.includes(ja)) return true;
  const fa = acronym(fromFilename), fb = acronym(headerName);
  return (!!fb && a.includes(fb)) || (!!fa && b.includes(fa));
}

// ─── Release-date ordering ─────────────────────────────────────────────────

/**
 * Keys of rows whose release date is EARLIER than that of a lower version —
 * v1.2 "released" before v1.1 — which is nearly always a typo. Rows without a
 * date are ignored (nothing to compare).
 */
export function dateOrderIssues(rows: Array<{ key: string; version: string; releaseDate: string }>): Set<string> {
  const flagged = new Set<string>();
  const sorted = [...rows].sort((x, y) => versionCompare(x.version, y.version));
  let latest = '';
  for (const r of sorted) {
    if (!r.releaseDate) continue;
    // 'YYYY-MM-DD' strings compare correctly as text.
    if (latest && r.releaseDate < latest) flagged.add(r.key);
    if (r.releaseDate > latest) latest = r.releaseDate;
  }
  return flagged;
}

// ─── Patch ↔ ROM pairing ───────────────────────────────────────────────────

export type PairConfidence = 'exact' | 'version';

export interface PairRow { key: string; filename: string; version: string }
export interface PairPatch { key: string; filename: string }
export interface PairResult {
  /** rowKey → the patch paired to it, and how sure that pairing is. */
  pairs: Map<string, { patchKey: string; confidence: PairConfidence }>;
  /** Patches that couldn't be paired unambiguously — left for the person to place. */
  unpaired: string[];
}

/**
 * Pairs patches with ROM rows, in two passes, each allowing ONLY a
 * one-to-one, unambiguous match:
 *   1. 'exact'   — the file names match apart from the extension
 *                  ("Hack v1.2.sfc" ↔ "Hack v1.2.bps").
 *   2. 'version' — the patch's version number equals the row's version label.
 * If two patches fit one row, or one patch fits two rows, NEITHER is paired
 * (guessing wrong here would attach the wrong version's patch), and they show
 * up in `unpaired` for the person to place by hand.
 */
export function pairPatches(rows: PairRow[], patches: PairPatch[]): PairResult {
  const pairs: PairResult['pairs'] = new Map();
  const usedPatch = new Set<string>();

  const pass = (confidence: PairConfidence, matches: (r: PairRow, p: PairPatch) => boolean) => {
    const free = rows.filter((r) => !pairs.has(r.key));
    const freePatches = patches.filter((p) => !usedPatch.has(p.key));
    const patchesFor = new Map(free.map((r) => [r.key, freePatches.filter((p) => matches(r, p))]));
    const rowsFor = new Map(freePatches.map((p) => [p.key, free.filter((r) => matches(r, p))]));
    for (const r of free) {
      const ps = patchesFor.get(r.key) ?? [];
      if (ps.length !== 1) continue; // none, or ambiguous
      if ((rowsFor.get(ps[0].key) ?? []).length !== 1) continue; // that patch fits several rows
      pairs.set(r.key, { patchKey: ps[0].key, confidence });
      usedPatch.add(ps[0].key);
    }
  };

  pass('exact', (r, p) => {
    const a = normalizeStem(r.filename);
    return a !== '' && a === normalizeStem(p.filename);
  });
  pass('version', (r, p) => {
    const rv = normalizeVersion(r.version);
    const pv = versionFromFilename(p.filename);
    return rv !== '' && !!pv && normalizeVersion(pv) === rv;
  });

  return { pairs, unpaired: patches.filter((p) => !usedPatch.has(p.key)).map((p) => p.key) };
}
