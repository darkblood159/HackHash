// src/lib/hackFamily.ts
//
// Groups different VERSIONS of the same hack (same name, same platform —
// e.g. "Kaizo Star Revenge 1" v1.0, v1.01, v1.02...) under one HackFamily row
// so they can be browsed/switched between together, and keeps their shared
// fields (hackName, author, releaseYear, releaseDate, description, tags) in sync.
//
// Design choice: Submission keeps its own hackName/author/releaseYear/
// releaseDate/description columns exactly as before — every existing reader (search,
// DAT export, CSV/JSON export, browse pages) needs zero changes. Only the
// WRITE paths (submission create, PATCH edit, change-request approval) know
// about families, and they fan a change out to every sibling at write time
// via propagateSharedFields/propagateTags below. This keeps the blast radius
// of this feature to the handful of places that actually mutate these
// fields, rather than every place that reads them.
//
import type { Platform } from '@/types';

// A transaction client type, same pragmatic choice as approval.ts's
// TxClient — the specific Prisma-generated transaction client type isn't
// imported here, `any` covers both a real $transaction callback client and
// the top-level `prisma` client (this file's functions are called from both,
// see src/app/api/submissions/route.ts).
type TxClient = any;

// ─── Field keys ─────────────────────────────────────────────────────────────
//
// The Submission columns that are expected to match across every version of
// a hack unless a specific version deliberately diverges. Deliberately does
// NOT include `version` (the one field that's supposed to differ per row) or
// anything patch/file/platform-specific (sourceUrl, notes, patch info,
// platform) — those stay per-submission always, no propagation.

export const SHARED_FIELD_KEYS = ['hackName', 'author', 'releaseYear', 'releaseDate', 'description'] as const;
export type SharedFieldKey = (typeof SHARED_FIELD_KEYS)[number];

export function isSharedFieldKey(key: string): key is SharedFieldKey {
  return (SHARED_FIELD_KEYS as readonly string[]).includes(key);
}

export interface SharedFieldChanges {
  name?: string;
  author?: string | null;
  releaseYear?: number | null;
  // ISO 'YYYY-MM-DD' string, matching the wire/DTO representation used
  // everywhere on the write side of this feature (Prisma accepts a plain
  // ISO string for a DateTime/@db.Date column, so nothing here needs to
  // construct an actual Date object). null = no full date known.
  releaseDate?: string | null;
  description?: string | null;
}

// ─── Release year/date resolution ───────────────────────────────────────────
//
// A @db.Date column comes back from Prisma as a Date object anchored at UTC
// midnight of that calendar date. Read it back via the UTC getters (not the
// local-timezone ones, and not JSON.stringify's own default — which would
// emit a full "...T00:00:00.000Z" timestamp, not a plain calendar date) so
// every API response that includes a release date uses the same plain
// 'YYYY-MM-DD' shape — the same shape an <input type="date"> expects as its
// value and the same shape the detailed export uses. Used at every read-side
// boundary that returns a release date: GET /api/submissions/check-similar-name
// (via FamilyMatch, indirectly), GET /api/entries/hack-family/[id], and
// src/lib/dat-generator.ts's detailed export.
export function toISODateOnly(d: Date | null | undefined): string | null {
  if (!d) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Two related but independent fields: releaseYear (year-only precision —
// "we know it's 2003, not the exact date") and releaseDate (the real
// month/day/year, when actually known). A submitter can provide either
// one, via a single toggle in the UI (full date vs. "I only know the
// year") — see SubmitForm.tsx/AdminEditPanel.tsx/ChangeRequestSection.tsx.
// This is the ONE place that turns whatever raw pair a request sent into
// the canonical pair to actually persist, so every write path (create,
// direct edit, change-request approval) derives releaseYear from
// releaseDate the same way rather than trusting a client-computed year to
// already agree with it. A full date always wins: if releaseDate is
// present, releaseYear is derived from it regardless of what else was
// sent. Neither present means genuinely unknown — both come back null,
// which callers use to explicitly clear existing values (this project's
// established PATCH pattern is "the key was present in the body, so
// apply it," including clearing a field to null — see allowedFields in
// src/app/api/submissions/[id]/route.ts).
export function resolveReleaseFields(input: {
  releaseDate?: string | null;
  releaseYear?: number | null;
}): { releaseDate: string | null; releaseYear: number | null } {
  if (input.releaseDate) {
    // The incoming value is a plain 'YYYY-MM-DD' string (from
    // <input type="date">, or a detailed-export re-import) with no time
    // component. Anchored to UTC midnight for that calendar date — both to
    // derive the year safely (avoids the classic "year rolls back/forward
    // depending on the server's local timezone" bug) and because this is
    // what actually gets persisted below.
    //
    // FIX (found live against a real write, Aug 14): Prisma Client's
    // DateTime scalar — even for a column mapped @db.Date, where Postgres
    // itself only stores the date part — requires a FULL ISO-8601 datetime
    // string or an actual Date object. A bare 'YYYY-MM-DD' throws
    // "Invalid value for argument `releaseDate`: premature end of input.
    // Expected ISO-8601 DateTime" the moment this reaches a real
    // .create()/.update() call — Prisma's own parser scans past the date
    // looking for a time component and runs out of string. The original
    // assumption that Prisma accepted a plain date string directly (see
    // this function's git history / the Aug 13 handoff notes) was never
    // actually exercised against a live write until now, and was wrong.
    // Every write path (submission create, PATCH, change-request approve,
    // bulk import) AND HackFamily's own create/update (via
    // resolveOrCreateFamily/propagateSharedFields below) funnels through
    // this one function, so fixing the shape here — once — fixes all of
    // them, rather than needing the same fix at every individual Prisma
    // call site. Read-side is unaffected: @db.Date columns always come back
    // from Prisma as a Date object regardless of what string/Date wrote
    // them, which is exactly what toISODateOnly() (this file) already
    // expects.
    // .split('T')[0] first — defensive/idempotent against being called with
    // its OWN already-resolved output. The bulk import route does exactly
    // this: familyRelease derivation falls back to this entry's own
    // already-resolved release.releaseDate (now a full ISO string, post
    // this fix) when entry.hackFamily?.releaseDate is absent — without this
    // normalization, that second call would double-append the time suffix
    // into an invalid string ("...T00:00:00.000ZT00:00:00.000Z").
    const datePart = input.releaseDate.split('T')[0];
    const isoDateTime = `${datePart}T00:00:00.000Z`;
    const year = new Date(isoDateTime).getUTCFullYear();
    return { releaseDate: isoDateTime, releaseYear: year };
  }
  if (input.releaseYear) {
    return { releaseDate: null, releaseYear: input.releaseYear };
  }
  return { releaseDate: null, releaseYear: null };
}

// ─── Name normalization ─────────────────────────────────────────────────────
//
// Same idea as normalizeQuery() in src/app/api/search/route.ts (lowercase,
// strip punctuation, collapse whitespace) but only needs a single comparable
// string here, not a word list — kept separate rather than sharing that
// function since the two normalization needs (fuzzy multi-strategy search
// vs. an exact grouping/uniqueness key) aren't guaranteed to want to change
// together.

export function normalizeNameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Scores how closely a name matches a (already-normalized) query — favors a
// match at the very start of the name, then the start of some later word,
// over a match merely buried somewhere inside a word. Used to rank both the
// text-search results (src/app/api/search/route.ts) and the name-suggestion
// dropdown (src/app/api/entries/autocomplete/route.ts) consistently, rather
// than each inventing its own ordering.
export function relevanceScore(name: string, normalizedQuery: string): number {
  if (!normalizedQuery) return 0;
  const normalizedName = normalizeNameKey(name);
  if (normalizedName === normalizedQuery) return 4;
  if (normalizedName.startsWith(normalizedQuery)) return 3;
  if (normalizedName.split(' ').some((w) => w.startsWith(normalizedQuery))) return 2;
  if (normalizedName.includes(normalizedQuery)) return 1;
  return 0;
}

// ─── Fuzzy matching ──────────────────────────────────────────────────────────
//
// Standard O(len(a) * len(b)) edit-distance DP, two rolling rows instead of a
// full matrix. Small enough (and used rarely enough — one call per new
// submission's name field) that pulling in a dependency for this isn't
// warranted.

export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,       // deletion
        curr[j - 1] + 1,   // insertion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// How close a name has to be to an existing family's name (on the same
// platform) to surface as a "did you mean…" suggestion via edit distance
// alone. Scales a little with name length so short names aren't
// over-matched and long names aren't under-matched; capped at 3 either way.
// Tune here if it's too noisy/quiet once there's real submission volume to
// look at. Exported since the admin duplicate-family finder uses the same
// rule (see findDuplicateFamilyCandidates below).
export function similarityThreshold(len: number): number {
  return Math.max(1, Math.min(3, Math.round(len * 0.15)));
}

// Catches a real, common pattern that edit distance alone misses entirely:
// a name with an edition/variant appended in the submitter's own free text
// — "24 Hour Hack" vs "24 Hour Hack (vTrue Ending)", "Hack Name" vs "Hack
// Name Christmas Edition". Each extra appended character adds ~1 to the raw
// edit distance, so anything longer than a couple of words blows straight
// past similarityThreshold() even though a person would instantly recognize
// it as the same hack. Requires a word boundary (the shorter string must be
// followed by a space in the longer one), not just any substring match —
// "Mario" is not a good match for "Mariomania".
function isPrefixPhrase(shorter: string, longer: string): boolean {
  if (shorter.length === 0 || shorter.length >= longer.length) return false;
  return longer.startsWith(shorter + ' ');
}

export interface FamilyMatch {
  id: string;
  name: string;
  author: string | null;
  releaseYear: number | null;
  releaseDate: Date | null;
  description: string | null;
}

export interface FamilyMatchResult {
  exactMatch: FamilyMatch | null;
  suggestions: Array<FamilyMatch & { distance: number; prefixMatch: boolean }>;
}

export async function findFamilyMatches(
  prisma: TxClient,
  name: string,
  platform: Platform
): Promise<FamilyMatchResult> {
  const key = normalizeNameKey(name);
  if (!key) return { exactMatch: null, suggestions: [] };

  const candidates: Array<FamilyMatch & { nameKey: string }> = await prisma.hackFamily.findMany({
    where: { platform },
    select: { id: true, name: true, nameKey: true, author: true, releaseYear: true, releaseDate: true, description: true },
  });

  const exact = candidates.find((c) => c.nameKey === key) ?? null;
  if (exact) return { exactMatch: exact, suggestions: [] };

  const suggestions = candidates
    .map((c) => {
      const distance = levenshteinDistance(key, c.nameKey);
      const [shorter, longer] = key.length <= c.nameKey.length ? [key, c.nameKey] : [c.nameKey, key];
      return { ...c, distance, prefixMatch: isPrefixPhrase(shorter, longer) };
    })
    .filter((c) => c.distance > 0 && (c.prefixMatch || c.distance <= similarityThreshold(Math.max(key.length, c.nameKey.length))))
    .sort((a, b) => (a.prefixMatch === b.prefixMatch ? a.distance - b.distance : a.prefixMatch ? -1 : 1))
    .slice(0, 3);

  return { exactMatch: null, suggestions };
}

// ─── Resolve-or-create (submission creation) ────────────────────────────────
//
// Looks up the exact-match family for a newly submitted hackName+platform,
// or creates one. By the time this runs, any near-match ambiguity should
// already have been resolved client-side via findFamilyMatches — this is a
// deterministic exact lookup, not a fuzzy one.

export async function resolveOrCreateFamily(
  tx: TxClient,
  params: {
    name: string;
    platform: Platform;
    author: string | null;
    releaseYear: number | null;
    releaseDate: string | null;
    description: string | null;
  },
  // True only when `tx` is a callback client from an open prisma.$transaction
  // (the bulk importer — see src/app/api/admin/import/route.ts). Defaults to
  // false because the other caller (src/app/api/submissions/route.ts) passes
  // the plain top-level `prisma` client, where every call below already
  // autocommits independently — a failed create there can't poison a later
  // query, and issuing SAVEPOINT with no open transaction block would itself
  // error ("SAVEPOINT can only be used in transaction blocks").
  inTransaction = false
): Promise<{ familyId: string; isNewFamily: boolean }> {
  const nameKey = normalizeNameKey(params.name);

  const existing = await tx.hackFamily.findUnique({
    where: { nameKey_platform: { nameKey, platform: params.platform } },
  });
  if (existing) return { familyId: existing.id, isNewFamily: false };

  // Postgres aborts the WHOLE surrounding transaction on any failed
  // statement, including this INSERT's own unique-constraint violation —
  // so inside an explicit transaction, without a savepoint, the "find the
  // race winner" recovery query below would ALSO fail (error 25P02,
  // "current transaction is aborted, commands ignored until end of
  // transaction block"), not just this create. That bubbles up through the
  // caller's outer catch as an unrelated, unexplained "Unexpected error
  // creating entry" for whichever entry lost the race, instead of
  // transparently joining the winner's family the way this function's
  // contract promises. Confirmed against a real Postgres instance (Aug 29):
  // reproduces every time two submissions for the same brand-new
  // name+platform are created inside the same prisma.$transaction
  // concurrently — which is exactly what happens when the bulk DAT importer
  // processes two versions of one hack (same hackName, same platform) in
  // the same chunk (see src/app/api/admin/import/route.ts's
  // CHUNK_SIZE/Promise.all).
  if (inTransaction) await tx.$executeRaw`SAVEPOINT resolve_family`;
  try {
    const created = await tx.hackFamily.create({
      data: {
        name: params.name,
        nameKey,
        platform: params.platform,
        author: params.author,
        releaseYear: params.releaseYear,
        releaseDate: params.releaseDate,
        description: params.description,
      },
    });
    return { familyId: created.id, isNewFamily: true };
  } catch (err: any) {
    // Another submission for the exact same new name+platform raced this one
    // and created the family first — use theirs rather than failing.
    if (err?.code === 'P2002') {
      if (inTransaction) await tx.$executeRaw`ROLLBACK TO SAVEPOINT resolve_family`;
      const raceWinner = await tx.hackFamily.findUniqueOrThrow({
        where: { nameKey_platform: { nameKey, platform: params.platform } },
      });
      return { familyId: raceWinner.id, isNewFamily: false };
    }
    throw err;
  }
}

// ─── Propagation ─────────────────────────────────────────────────────────────
//
// Updates the family row itself plus every OTHER member submission
// (excludeSubmissionId is normally the submission whose own edit triggered
// this — its own row is updated separately by the caller in the same
// transaction, so it's deliberately excluded here to avoid a redundant
// second write).

export async function propagateSharedFields(
  tx: TxClient,
  familyId: string,
  excludeSubmissionId: string,
  changes: SharedFieldChanges
): Promise<void> {
  const familyUpdate: Record<string, unknown> = {};
  if (changes.name !== undefined) {
    familyUpdate.name = changes.name;
    familyUpdate.nameKey = normalizeNameKey(changes.name);
  }
  if (changes.author !== undefined) familyUpdate.author = changes.author;
  if (changes.releaseYear !== undefined) familyUpdate.releaseYear = changes.releaseYear;
  if (changes.releaseDate !== undefined) familyUpdate.releaseDate = changes.releaseDate;
  if (changes.description !== undefined) familyUpdate.description = changes.description;

  if (Object.keys(familyUpdate).length > 0) {
    await tx.hackFamily.update({ where: { id: familyId }, data: familyUpdate });
  }

  const siblingUpdate: Record<string, unknown> = {};
  if (changes.name !== undefined) siblingUpdate.hackName = changes.name;
  if (changes.author !== undefined) siblingUpdate.author = changes.author;
  if (changes.releaseYear !== undefined) siblingUpdate.releaseYear = changes.releaseYear;
  if (changes.releaseDate !== undefined) siblingUpdate.releaseDate = changes.releaseDate;
  if (changes.description !== undefined) siblingUpdate.description = changes.description;

  if (Object.keys(siblingUpdate).length > 0) {
    await tx.submission.updateMany({
      where: { hackFamilyId: familyId, id: { not: excludeSubmissionId } },
      data: siblingUpdate,
    });
  }
}

// Full-replace tag sync, same semantics as the existing per-submission tag
// edit (delete then recreate) — just repeated for every sibling.
export async function propagateTags(
  tx: TxClient,
  familyId: string,
  excludeSubmissionId: string,
  tagIds: string[]
): Promise<void> {
  const siblings: Array<{ id: string }> = await tx.submission.findMany({
    where: { hackFamilyId: familyId, id: { not: excludeSubmissionId } },
    select: { id: true },
  });
  if (siblings.length === 0) return;

  await tx.submissionTag.deleteMany({ where: { submissionId: { in: siblings.map((s) => s.id) } } });
  if (tagIds.length > 0) {
    await tx.submissionTag.createMany({
      data: siblings.flatMap((s) => tagIds.map((tagId) => ({ submissionId: s.id, tagId }))),
      skipDuplicates: true,
    });
  }
}

// ─── Admin duplicate-family finder ──────────────────────────────────────────
//
// Scans every existing HackFamily for pairs (same platform) that look like
// they're actually the same hack under the SAME rules used above for new
// submissions (exact edit-distance threshold + the prefix-phrase check) —
// surfaced so an admin can review and merge them, e.g. after a backfill ran
// on data that predates this feature and has real naming inconsistencies
// (an edition/variant appended to the name rather than living in `version`).
// O(n²) within each platform group — fine at the scale this runs at (an
// admin-triggered page load, not a hot path), but if a single platform ever
// has many thousands of families this would want a smarter approach
// (trigram index, bucketing by first few characters, etc).

export interface DuplicateFamilyPair {
  a: { id: string; name: string; versionCount: number };
  b: { id: string; name: string; versionCount: number };
  platform: string;
  distance: number;
  prefixMatch: boolean;
}

export async function findDuplicateFamilyCandidates(prisma: TxClient, limit = 200): Promise<DuplicateFamilyPair[]> {
  const [families, dismissed]: [
    Array<{ id: string; name: string; nameKey: string; platform: string; _count: { submissions: number } }>,
    Array<{ familyAId: string; familyBId: string }>
  ] = await Promise.all([
    prisma.hackFamily.findMany({
      select: { id: true, name: true, nameKey: true, platform: true, _count: { select: { submissions: true } } },
    }),
    prisma.dismissedFamilyPair.findMany({ select: { familyAId: true, familyBId: true } }),
  ]);

  const dismissedKeys = new Set(dismissed.map((d) => dismissalKey(d.familyAId, d.familyBId)));

  const byPlatform = new Map<string, typeof families>();
  for (const f of families) {
    const list = byPlatform.get(f.platform) ?? [];
    list.push(f);
    byPlatform.set(f.platform, list);
  }

  const pairs: DuplicateFamilyPair[] = [];
  for (const list of Array.from(byPlatform.values())) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const x = list[i];
        const y = list[j];
        if (dismissedKeys.has(dismissalKey(x.id, y.id))) continue;
        const distance = levenshteinDistance(x.nameKey, y.nameKey);
        const [shorter, longer] = x.nameKey.length <= y.nameKey.length ? [x.nameKey, y.nameKey] : [y.nameKey, x.nameKey];
        const prefixMatch = isPrefixPhrase(shorter, longer);
        if (distance > 0 && (prefixMatch || distance <= similarityThreshold(Math.max(x.nameKey.length, y.nameKey.length)))) {
          pairs.push({
            a: { id: x.id, name: x.name, versionCount: x._count.submissions },
            b: { id: y.id, name: y.name, versionCount: y._count.submissions },
            platform: x.platform,
            distance,
            prefixMatch,
          });
        }
      }
    }
  }

  pairs.sort((a, b) => (a.prefixMatch === b.prefixMatch ? a.distance - b.distance : a.prefixMatch ? -1 : 1));
  return pairs.slice(0, limit);
}

// ─── Single-submission family reassignment ──────────────────────────────────
//
// Moves ONE submission into a different existing family, or detaches it
// (hackFamilyId: null) — distinct from a MERGE, which moves every
// submission out of one family into another. Shared by two callers: the
// direct admin endpoint (POST /api/admin/submissions/[id]/family, used by
// both the approval-menu picker and AdminEditPanel's direct edit) and the
// change-request approval route (when a proposed family change is
// approved) — extracted here specifically so both go through the exact
// same validation (target family must exist and match the submission's
// platform) and cleanup (delete the vacated family if it's now empty)
// rather than risking the two call sites drifting apart. 
//
// Deliberately does NOT touch the submission's own hackName/author/etc —
// same "connect, don't force-overwrite" philosophy as the backfill and the
// merge tool (see this file's header comment).

export class FamilyReassignError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface FamilyReassignResult {
  changed: boolean;
  targetName: string | null;
}

export async function reassignSubmissionFamily(
  tx: TxClient,
  submission: { id: string; hackFamilyId: string | null; platform: string },
  hackFamilyId: string | null,
  actorId: string | null
): Promise<FamilyReassignResult> {
  if (hackFamilyId === submission.hackFamilyId) {
    return { changed: false, targetName: null };
  }

  let targetName: string | null = null;
  if (hackFamilyId) {
    const target = await tx.hackFamily.findUnique({ where: { id: hackFamilyId } });
    if (!target) {
      throw new FamilyReassignError('Target family not found', 404);
    }
    if (target.platform !== submission.platform) {
      throw new FamilyReassignError(
        `That family is for ${target.platform}, not ${submission.platform} — families are platform-specific.`,
        422
      );
    }
    targetName = target.name;
  }

  const previousFamilyId = submission.hackFamilyId;

  await tx.submission.update({ where: { id: submission.id }, data: { hackFamilyId } });

  // If the family this submission just left is now empty, it's dead
  // weight — clean it up rather than leaving an orphaned row cluttering
  // the family list and the duplicate-finder's scan. Same cleanup the
  // merge tool already does for its own "from" family. Safe regardless of
  // schema-level onDelete behavior: nothing references it anymore by the
  // time this runs (the update above already moved the only submission
  // that did), so this is a plain delete of a genuinely empty row.
  if (previousFamilyId) {
    const remaining = await tx.submission.count({ where: { hackFamilyId: previousFamilyId } });
    if (remaining === 0) {
      await tx.hackFamily.delete({ where: { id: previousFamilyId } });
    }
  }

  await tx.auditLog.create({
    data: {
      action: 'SUBMISSION_FAMILY_CHANGED',
      details: { by: actorId, from: previousFamilyId, to: hackFamilyId },
      userId: actorId,
      submissionId: submission.id,
    },
  });

  return { changed: true, targetName };
}

// ─── Dismissals ──────────────────────────────────────────────────────────────
//
// Normalized (order-independent) key for a pair of family ids — always the
// lexicographically smaller id first, so "A,B" and "B,A" produce the same
// key and can't be stored/checked as two different pairs.
function dismissalKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}::${idB}` : `${idB}::${idA}`;
}

// Records "these two are confirmed NOT the same hack" so
// findDuplicateFamilyCandidates stops suggesting the pair. Idempotent —
// dismissing an already-dismissed pair is a harmless no-op.
export async function dismissDuplicatePair(
  tx: TxClient,
  familyAId: string,
  familyBId: string,
  dismissedById: string | null
): Promise<void> {
  const [a, b] = familyAId < familyBId ? [familyAId, familyBId] : [familyBId, familyAId];
  try {
    await tx.dismissedFamilyPair.create({ data: { familyAId: a, familyBId: b, dismissedById } });
  } catch (err: any) {
    if (err?.code !== 'P2002') throw err; // already dismissed — fine
  }
}

// ─── Export/import support ───────────────────────────────────────────────────
//
// Used by the detailed DAT export (src/lib/dat-generator.ts) so a full
// database rebuild from that file doesn't lose family groupings or
// dismissal decisions — see the export/import functions below for how each
// side uses this. Names, not ids, since ids won't survive a rebuild (a
// re-import creates brand new HackFamily rows); nameKey is recomputed from
// name on the import side rather than exported/trusted directly, so it
// can't ever drift out of sync with normalizeNameKey()'s current behavior.

export interface DismissedPairExport {
  platform: string;
  nameA: string;
  nameB: string;
}

export async function getDismissedPairsForExport(prisma: TxClient, platform?: string): Promise<DismissedPairExport[]> {
  const rows = await prisma.dismissedFamilyPair.findMany({
    where: platform ? { familyA: { platform } } : {},
    select: {
      familyA: { select: { name: true, platform: true } },
      familyB: { select: { name: true } },
    },
  });
  return rows.map((r: any) => ({ platform: r.familyA.platform, nameA: r.familyA.name, nameB: r.familyB.name }));
}
