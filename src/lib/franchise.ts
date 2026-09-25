// src/lib/franchise.ts
//
// Shared logic for the Franchise entity (prisma/schema.prisma) — a
// deduplicated game franchise/series (Super Mario, The Legend of Zelda,
// Pokémon...) that hacks can be grouped and filtered under. See the schema
// comment above the Franchise model for the full "why"; this file mirrors
// the same resolve-or-create shape as resolveOrCreateBaseRom (src/lib/
// baseRom.ts) and resolveOrCreateFamily (src/lib/hackFamily.ts), for the
// same reasons — it's called from both live API routes and the DAT
// importer, and needs the same concurrent-create handling either way.
//
// The point of the whole feature is "don't let people create duplicates of
// the same franchise", so dedupe is layered:
//   1. Exact identity — nameKey (normalizeNameKey, the same normalizer
//      HackFamily uses) is globally unique. "Super Mario", "super  mario",
//      and "Super-Mario" are one row, enforced by the database itself.
//   2. resolveOrCreateFranchise returns the EXISTING row on a collision —
//      including one created a moment ago by someone else (P2002 race
//      recovery) — rather than failing or making a second one.
//   3. searchFranchises surfaces near-misses (contains-matches AND a small
//      edit-distance allowance, reusing hackFamily.ts's own fuzzy-matching
//      helpers) so the picker can show "did you mean…" BEFORE offering to
//      create something new.
//   4. An admin merge tool (POST /api/admin/franchises/[id]/merge) as the
//      safety net for whatever slips through anyway.

import { normalizeNameKey, similarityThreshold, relevanceScore } from './hackFamily';

// Same pragmatic choice as baseRom.ts / hackFamily.ts — `any` covers both a
// real $transaction callback client and the top-level `prisma` client.
type TxClient = any;

export const FRANCHISE_NAME_MAX = 120;

// How many franchises a single NON-admin can have sitting in PENDING at
// once. A soft abuse guard, not a real expected limit — someone
// legitimately proposing more than a handful of brand-new franchises at
// the same moment is very unusual. Admins are exempt (they create
// franchises as already-APPROVED anyway).
export const MAX_PENDING_FRANCHISES_PER_USER = 10;

export type FranchiseStatusValue = 'PENDING' | 'APPROVED';

export interface FranchiseSummary {
  id: string;
  name: string;
  status: FranchiseStatusValue;
}

// Thrown for a name that can't become a franchise at all (empty after
// normalization, or too long) — distinct from FranchiseAssignError below,
// which is about a valid name/id that can't be applied to a submission.
export class FranchiseNameError extends Error {}

export class FranchiseAssignError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// Trim + collapse runs of whitespace. Deliberately does NOT touch case or
// punctuation — the display name keeps whatever the person typed ("Pokémon",
// "The Legend of Zelda"); only nameKey (below) is normalized for matching.
export function cleanFranchiseName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

// ─── Resolve-or-create ───────────────────────────────────────────────────────

export interface ResolveFranchiseParams {
  name: string;
  submittedById?: string | null;
  // Defaults to PENDING (the normal path — a submitter proposing a new
  // one). Two callers pass APPROVED: an admin creating one directly, and
  // the DAT importer preserving an already-approved franchise's status
  // across a rebuild. NOTE: if the franchise ALREADY exists as PENDING and
  // APPROVED is requested here, it's promoted — "make sure this exists at
  // least at this status" — but a PENDING request never demotes an
  // existing APPROVED one.
  status?: FranchiseStatusValue;
  approvedById?: string | null;
  approvedAt?: Date | null;
}

export interface ResolvedFranchise {
  franchiseId: string;
  isNew: boolean;
  // True only when an existing PENDING row was just promoted to APPROVED by
  // this call (see `status` above) — lets a caller write an accurate audit
  // log entry ("approved", not "created").
  promoted: boolean;
  name: string;
  status: FranchiseStatusValue;
}

async function promoteIfNeeded(tx: TxClient, existing: any, params: ResolveFranchiseParams): Promise<ResolvedFranchise> {
  if (params.status === 'APPROVED' && existing.status !== 'APPROVED') {
    const updated = await tx.franchise.update({
      where: { id: existing.id },
      data: { status: 'APPROVED', approvedById: params.approvedById ?? null, approvedAt: params.approvedAt ?? new Date() },
    });
    return { franchiseId: updated.id, isNew: false, promoted: true, name: updated.name, status: 'APPROVED' };
  }
  return { franchiseId: existing.id, isNew: false, promoted: false, name: existing.name, status: existing.status as FranchiseStatusValue };
}

export async function resolveOrCreateFranchise(
  tx: TxClient,
  params: ResolveFranchiseParams,
  // True only when `tx` is a callback client from an open prisma.$transaction
  // (the bulk DAT importer — see src/app/api/admin/import/route.ts). Same
  // reasoning as the matching parameter on resolveOrCreateBaseRom: Postgres
  // aborts the WHOLE surrounding transaction on this create's own unique-
  // constraint violation, so without a savepoint the recovery lookup below
  // would fail too (25P02), not just the insert. Defaults to false for the
  // plain top-level `prisma` client, which has no surrounding transaction
  // to protect (and can't use a savepoint outside one).
  inTransaction = false
): Promise<ResolvedFranchise> {
  const name = cleanFranchiseName(params.name);
  const nameKey = normalizeNameKey(name);
  if (!nameKey) {
    throw new FranchiseNameError('A franchise name needs at least one letter or number.');
  }
  if (name.length > FRANCHISE_NAME_MAX) {
    throw new FranchiseNameError(`Franchise names can be at most ${FRANCHISE_NAME_MAX} characters.`);
  }
  const status: FranchiseStatusValue = params.status ?? 'PENDING';

  const existing = await tx.franchise.findUnique({ where: { nameKey } });
  if (existing) return promoteIfNeeded(tx, existing, params);

  if (inTransaction) await tx.$executeRaw`SAVEPOINT resolve_franchise`;
  try {
    const created = await tx.franchise.create({
      data: {
        name,
        nameKey,
        status,
        submittedById: params.submittedById ?? null,
        approvedById: status === 'APPROVED' ? params.approvedById ?? null : null,
        approvedAt: status === 'APPROVED' ? params.approvedAt ?? new Date() : null,
      },
    });
    return { franchiseId: created.id, isNew: true, promoted: false, name: created.name, status: created.status as FranchiseStatusValue };
  } catch (err: any) {
    // Someone else created the same franchise in the window between the
    // lookup above and this insert — use theirs rather than failing.
    if (err?.code === 'P2002') {
      if (inTransaction) await tx.$executeRaw`ROLLBACK TO SAVEPOINT resolve_franchise`;
      const raceWinner = await tx.franchise.findUniqueOrThrow({ where: { nameKey } });
      return promoteIfNeeded(tx, raceWinner, params);
    }
    throw err;
  }
}

// ─── Search / near-match ─────────────────────────────────────────────────────

// Edit distance where swapping two ADJACENT letters counts as ONE edit
// (optimal string alignment) — unlike the plain Levenshtein distance in
// src/lib/hackFamily.ts, where a swap costs two. Swapped letters are the
// single most common typo ("Metriod", "Mairo", "Zleda"), and at the short
// lengths franchise names/words usually have, similarityThreshold() only
// allows ONE edit, so under plain Levenshtein those typos would never be
// suggested — which is exactly the case this fuzzy matching exists for.
// Local to this file (rather than changing the shared helper) so the
// family-duplicate detection that uses the plain version behaves exactly
// as before.
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

export interface FranchiseSearchHit extends FranchiseSummary {
  // The typed query normalizes to exactly this franchise's own name.
  exact: boolean;
  // Not a substring match, but close enough by edit distance to be worth
  // showing as a "did you mean…" — see searchFranchises.
  similar: boolean;
}

export interface FranchiseSearchResult {
  hits: FranchiseSearchHit[];
  exactMatch: FranchiseSummary | null;
}

// Searches by name. An empty query returns a plain browse list (approved
// first, then alphabetical) so a picker has something to show the moment
// it opens. A typed query returns substring matches ranked with the same
// relevanceScore() the site's other name searches use (so "zel" finds
// "The Legend of Zelda" at a word-start), plus near-misses within a small
// edit distance (a swapped pair of letters counts as one edit — see
// editDistance) of the whole name or of any single word in it — that's
// what catches a typo like "Metriod" for "Metroid" without needing the
// person to get the spelling right.
//
// Loads the whole candidate list and filters in memory rather than trying
// to express fuzzy matching in SQL: franchises are a small table (hundreds,
// not tens of thousands), the same reasoning findDuplicateFamilyCandidates
// (src/lib/hackFamily.ts) already documents for its own in-memory pass.
// The `take` below is a hard safety cap, not an expected size.
export async function searchFranchises(
  client: TxClient,
  q: string | undefined,
  opts: { includePending: boolean; limit: number; excludeId?: string }
): Promise<FranchiseSearchResult> {
  const rows: Array<{ id: string; name: string; nameKey: string; status: FranchiseStatusValue }> = await client.franchise.findMany({
    where: opts.includePending ? {} : { status: 'APPROVED' },
    select: { id: true, name: true, nameKey: true, status: true },
    orderBy: { name: 'asc' },
    take: 2000,
  });

  const candidates = opts.excludeId ? rows.filter((r) => r.id !== opts.excludeId) : rows;
  const normalized = q ? normalizeNameKey(q) : '';
  const byStatusThenName = (a: { status: string; name: string }, b: { status: string; name: string }) =>
    a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'APPROVED' ? -1 : 1;

  if (!normalized) {
    const hits = [...candidates].sort(byStatusThenName).slice(0, opts.limit).map((r) => ({
      id: r.id, name: r.name, status: r.status, exact: false, similar: false,
    }));
    return { hits, exactMatch: null };
  }

  const scored = candidates
    .map((r) => {
      const score = relevanceScore(r.name, normalized); // 4 exact, 3 prefix, 2 word-prefix, 1 substring, 0 none
      let similar = false;
      if (score === 0 && normalized.length >= 4) {
        const threshold = similarityThreshold(normalized.length);
        const targets = [r.nameKey, ...r.nameKey.split(' ')].filter((t) => t.length >= 3);
        similar = targets.some((t) => editDistance(normalized, t) <= threshold);
      }
      return { r, score, similar };
    })
    .filter((x) => x.score > 0 || x.similar)
    .sort((a, b) => b.score - a.score || byStatusThenName(a.r, b.r));

  const hits: FranchiseSearchHit[] = scored.slice(0, opts.limit).map(({ r, score, similar }) => ({
    id: r.id, name: r.name, status: r.status, exact: score === 4, similar,
  }));
  const exact = scored.find((x) => x.score === 4);
  return {
    hits,
    exactMatch: exact ? { id: exact.r.id, name: exact.r.name, status: exact.r.status } : null,
  };
}

// ─── Browse-page filter options ──────────────────────────────────────────────
//
// Which franchises the public filter dropdown offers: only APPROVED ones
// (a pending, not-yet-reviewed name shouldn't appear in a public filter),
// and only ones that would actually return something on the page in
// question — an empty filter option is just noise. `entries` (the
// Database page) needs a live, APPROVED entry behind it; `submissions`
// (the review queue, which shows every status) needs any live submission.
export async function getFranchiseFilterOptions(
  client: TxClient,
  scope: 'entries' | 'submissions',
  // The franchise currently selected via the URL, if any. Always included
  // in the result even when it wouldn't normally qualify (still pending,
  // or no results on this page), so the dropdown never shows a selection
  // that isn't one of its own options.
  alsoInclude?: { id: string; name: string } | null
): Promise<Array<{ id: string; name: string }>> {
  const submissionWhere = scope === 'entries'
    ? { deletedAt: null, approvedEntry: { isNot: null } }
    : { deletedAt: null };
  const rows: Array<{ id: string; name: string }> = await client.franchise.findMany({
    where: { status: 'APPROVED', submissions: { some: submissionWhere } },
    select: { id: true, name: true },
  });
  if (alsoInclude && !rows.some((r) => r.id === alsoInclude.id)) {
    rows.push({ id: alsoInclude.id, name: alsoInclude.name });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Assignment (putting a franchise on an existing submission) ──────────────

// Validates a proposed target before it's written anywhere — a clean 4xx
// instead of a raw foreign-key violation (a confusing 500) if the row was
// removed or merged away since the picker loaded it. `client` accepts
// either the plain prisma client (a read-only pre-check) or an open
// transaction, same trick validateBaseRomAssignment uses. PENDING is
// allowed, matching how a pending base rom is: a submission isn't blocked
// on its franchise's own review finishing.
export async function validateFranchiseAssignment(client: TxClient, franchiseId: string): Promise<FranchiseSummary> {
  const target = await client.franchise.findUnique({
    where: { id: franchiseId },
    select: { id: true, name: true, status: true },
  });
  if (!target) {
    throw new FranchiseAssignError('That franchise no longer exists — please pick it again.', 422);
  }
  return { id: target.id, name: target.name, status: target.status as FranchiseStatusValue };
}

// Full-replace franchise sync to every OTHER version of a hack — same
// "family-shared, propagated at write time" treatment propagateTags
// (src/lib/hackFamily.ts) gives tags. franchiseId can be null, which
// clears it on the siblings too.
export async function propagateFranchise(
  tx: TxClient,
  familyId: string,
  excludeSubmissionId: string,
  franchiseId: string | null
): Promise<void> {
  await tx.submission.updateMany({
    where: { hackFamilyId: familyId, id: { not: excludeSubmissionId } },
    data: { franchiseId },
  });
}

// Standalone apply step for the change-request approval route — validates,
// writes, optionally fans out to the rest of the family, and logs. Reads
// the submission's CURRENT hackFamilyId itself instead of trusting a
// caller-supplied one: the same approval can also reassign the family a
// few lines earlier in the same transaction, and propagation should target
// wherever the submission actually lives now. The direct-edit PATCH route
// (src/app/api/submissions/[id]/route.ts) doesn't use this — it folds
// franchiseId into its own already-in-flight update, same reasoning
// baseRom.ts documents for reassignSubmissionBaseRom.
export async function reassignSubmissionFranchise(
  tx: TxClient,
  submissionId: string,
  franchiseId: string | null,
  actorId: string,
  applyToFamily: boolean
): Promise<void> {
  const target = franchiseId ? await validateFranchiseAssignment(tx, franchiseId) : null;

  const current: { franchiseId: string | null; hackFamilyId: string | null } | null = await tx.submission.findUnique({
    where: { id: submissionId },
    select: { franchiseId: true, hackFamilyId: true },
  });
  if (!current) throw new FranchiseAssignError('Submission not found', 404);

  await tx.submission.update({ where: { id: submissionId }, data: { franchiseId } });

  const fannedOut = applyToFamily && !!current.hackFamilyId;
  if (fannedOut) {
    await propagateFranchise(tx, current.hackFamilyId as string, submissionId, franchiseId);
  }

  await tx.auditLog.create({
    data: {
      action: 'SUBMISSION_FRANCHISE_CHANGED',
      details: { from: current.franchiseId, to: franchiseId, toName: target?.name ?? null, appliedToAllVersions: fannedOut },
      userId: actorId,
      submissionId,
    },
  });
}
