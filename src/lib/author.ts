// src/lib/author.ts
//
// Shared logic for the Author entity (prisma/schema.prisma) — a
// deduplicated list of the people/teams credited with hacks, picked from a
// shared list instead of retyped as free text every time. This file
// deliberately mirrors src/lib/franchise.ts almost line for line — same
// resolve-or-create shape, same fuzzy search, same PENDING/APPROVED/merge
// moderation model (no REJECTED, no hash to verify — the only real question
// is "is this a duplicate of someone already listed" — same as a franchise)
// — because it's the same kind of entity solving the same kind of problem.
// See that file's own top comment for the full "why" behind each layer of
// dedupe; it isn't repeated here.
//
// The real differences from Franchise:
//  1. Submission already had a plain free-text `author` STRING column (see
//     that field's long comment in prisma/schema.prisma) long before this
//     entity existed, and it's far too deeply read elsewhere (search, the DAT
//     export/import, HackFamily's shared-field propagation) to replace. So
//     every function here that changes a submission's authors also keeps that
//     string column in sync as a denormalized cache of the linked Authors'
//     CURRENT names — resolved fresh from the Author rows, never trusted from
//     a caller-supplied string. Franchise has no such string to keep in sync.
//  2. A hack can credit SEVERAL authors (the SubmissionAuthor join table,
//     ordered by `position`), where it has at most one franchise. The cache
//     string is the names joined in that order with AUTHOR_SEPARATOR.

import type { Prisma, PrismaClient } from '@prisma/client';
import { similarityThreshold } from './hackFamily';
import { MAX_AUTHORS_PER_SUBMISSION, AUTHOR_SEPARATOR, authorsCacheString } from './authorList';

// Re-exported so server code keeps one import path; the definitions live in
// the zero-import authorList.ts so browser components can use them too.
export { MAX_AUTHORS_PER_SUBMISSION, AUTHOR_SEPARATOR, authorsCacheString };

// Same pragmatic choice as franchise.ts/baseRom.ts/hackFamily.ts — `any`
// covers both a real $transaction callback client and the top-level `prisma`
// client. (The legacy-author import at the bottom of this file is the
// exception: it only ever runs against the top-level client and is typed
// against the generated Prisma types, so a mistyped column or filter there
// fails the typecheck instead of failing at runtime on real data.)
type TxClient = any;

// Matches the existing free-text `author` column's own cap (see
// NULLABLE_FIELD_LIMITS.author in src/lib/fieldLimits.ts and the create
// route's identical z.string().max(200)) rather than reusing Franchise's
// 120 — an author "name" here can be a whole credited team ("John Doe & The
// Hack Team"), not just a single proper noun, and anything that was
// previously valid as free text should stay representable once linked to a
// real Author row.
export const AUTHOR_NAME_MAX = 200;

// Same soft abuse guard as MAX_PENDING_FRANCHISES_PER_USER, not a real
// expected limit. Admins are exempt (their own creation is the approval).
export const MAX_PENDING_AUTHORS_PER_USER = 10;

export type AuthorStatusValue = 'PENDING' | 'APPROVED';

export interface AuthorSummary {
  id: string;
  name: string;
  status: AuthorStatusValue;
}

// Thrown for a name that can't become an author at all (empty after
// normalization, or too long) — distinct from AuthorAssignError below,
// which is about a valid name/id that can't be applied to a submission.
export class AuthorNameError extends Error {}

export class AuthorAssignError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// Trim + collapse runs of whitespace. Deliberately does NOT touch case or
// punctuation — the display name keeps whatever the person typed
// ("RomHacker99", "The Translation Corporation"); only nameKey (below) is
// normalized for matching.
export function cleanAuthorName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

// ─── Name key ────────────────────────────────────────────────────────────────

// The matching key for "is this the same author" — what's stored in the
// unique Author.nameKey column and what the picker's search compares against.
//
// This is deliberately NOT normalizeNameKey() from hackFamily.ts, which
// franchise.ts uses. That one keeps only a-z0-9, which is fine for hack and
// franchise titles but wrong for people's handles: a name written in any other
// script (ロムハッカー, Кирилл, 田中太郎) normalizes to the EMPTY string — so it
// could never become an Author at all — and two different names that differ
// only in their non-ASCII characters (Ünal / Ïnal, both "nal") collapse to one
// key and would be silently treated as the same person.
//
// Same shape (lowercase, punctuation → space, collapse whitespace, trim) but it
// keeps every letter, combining mark and digit in ANY script. NFKC first so
// compatibility variants of one character compare equal (full-width
// "ＲｏｍＨａｃｋｅｒ", half-width katakana). Accents are deliberately NOT
// stripped: "Bjorn" and "Björn" stay separate keys — the picker's edit-distance
// "similar" match puts that pair in front of a human to decide, whereas
// stripping combining marks would also wrongly collapse distinct kana (が / か).
//
// For ASCII-only input this is identical to normalizeNameKey(), so no key that
// was valid before changes.
//
// Built with the RegExp constructor instead of a /…/u literal on purpose: this
// project's tsconfig sets no `target`, and TypeScript rejects the `u` flag in a
// literal below ES2015 (TS1501). The constructor form isn't syntax-checked and
// behaves identically at runtime (Node 20+). The `g` flag is safe on a shared
// constant here because it's only ever used with String.replace, which resets
// lastIndex itself (unlike .test/.exec).
const NAME_KEY_STRIP = new RegExp('[^\\p{L}\\p{M}\\p{N}\\s]', 'gu');

export function authorNameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(NAME_KEY_STRIP, ' ').replace(/\s+/g, ' ').trim();
}

// Same ranking as hackFamily.ts's relevanceScore() — 4 exact, 3 prefix, 2
// word-prefix, 1 substring, 0 none — but computed over authorNameKey() so it
// agrees with what's stored in Author.nameKey. The shared version normalizes
// with the ASCII-only key and would score every non-Latin name 0.
function authorRelevance(name: string, normalizedQuery: string): number {
  if (!normalizedQuery) return 0;
  const n = authorNameKey(name);
  if (n === normalizedQuery) return 4;
  if (n.startsWith(normalizedQuery)) return 3;
  if (n.split(' ').some((w) => w.startsWith(normalizedQuery))) return 2;
  if (n.includes(normalizedQuery)) return 1;
  return 0;
}

// ─── Resolve-or-create ───────────────────────────────────────────────────────

export interface ResolveAuthorParams {
  name: string;
  submittedById?: string | null;
  // Defaults to PENDING (the normal path — a submitter proposing a new
  // one). Two callers pass APPROVED: an admin creating one directly, and
  // the DAT importer preserving an already-approved author's status across
  // a rebuild. NOTE: if the author ALREADY exists as PENDING and APPROVED
  // is requested here, it's promoted — "make sure this exists at least at
  // this status" — but a PENDING request never demotes an existing
  // APPROVED one.
  status?: AuthorStatusValue;
  approvedById?: string | null;
  approvedAt?: Date | null;
}

export interface ResolvedAuthor {
  authorId: string;
  isNew: boolean;
  // True only when an existing PENDING row was just promoted to APPROVED by
  // this call — lets a caller write an accurate audit log entry
  // ("approved", not "created").
  promoted: boolean;
  name: string;
  status: AuthorStatusValue;
}

async function promoteIfNeeded(tx: TxClient, existing: any, params: ResolveAuthorParams): Promise<ResolvedAuthor> {
  if (params.status === 'APPROVED' && existing.status !== 'APPROVED') {
    const updated = await tx.author.update({
      where: { id: existing.id },
      data: { status: 'APPROVED', approvedById: params.approvedById ?? null, approvedAt: params.approvedAt ?? new Date() },
    });
    return { authorId: updated.id, isNew: false, promoted: true, name: updated.name, status: 'APPROVED' };
  }
  return { authorId: existing.id, isNew: false, promoted: false, name: existing.name, status: existing.status as AuthorStatusValue };
}

export async function resolveOrCreateAuthor(
  tx: TxClient,
  params: ResolveAuthorParams,
  // True only when `tx` is a callback client from an open prisma.$transaction
  // (the bulk DAT importer — see src/app/api/admin/import/route.ts). Same
  // reasoning as the matching parameter on resolveOrCreateFranchise:
  // Postgres aborts the WHOLE surrounding transaction on this create's own
  // unique-constraint violation, so without a savepoint the recovery lookup
  // below would fail too (25P02), not just the insert. Defaults to false
  // for the plain top-level `prisma` client, which has no surrounding
  // transaction to protect (and can't use a savepoint outside one).
  inTransaction = false
): Promise<ResolvedAuthor> {
  const name = cleanAuthorName(params.name);
  const nameKey = authorNameKey(name);
  if (!nameKey) {
    throw new AuthorNameError('An author name needs at least one letter or number.');
  }
  if (name.length > AUTHOR_NAME_MAX) {
    throw new AuthorNameError(`Author names can be at most ${AUTHOR_NAME_MAX} characters.`);
  }
  const status: AuthorStatusValue = params.status ?? 'PENDING';

  const existing = await tx.author.findUnique({ where: { nameKey } });
  if (existing) return promoteIfNeeded(tx, existing, params);

  if (inTransaction) await tx.$executeRaw`SAVEPOINT resolve_author`;
  try {
    const created = await tx.author.create({
      data: {
        name,
        nameKey,
        status,
        submittedById: params.submittedById ?? null,
        approvedById: status === 'APPROVED' ? params.approvedById ?? null : null,
        approvedAt: status === 'APPROVED' ? params.approvedAt ?? new Date() : null,
      },
    });
    return { authorId: created.id, isNew: true, promoted: false, name: created.name, status: created.status as AuthorStatusValue };
  } catch (err: any) {
    // Someone else created the same author in the window between the
    // lookup above and this insert — use theirs rather than failing.
    if (err?.code === 'P2002') {
      if (inTransaction) await tx.$executeRaw`ROLLBACK TO SAVEPOINT resolve_author`;
      const raceWinner = await tx.author.findUniqueOrThrow({ where: { nameKey } });
      return promoteIfNeeded(tx, raceWinner, params);
    }
    throw err;
  }
}

// ─── Search / near-match ─────────────────────────────────────────────────────

// Edit distance where swapping two ADJACENT letters counts as ONE edit
// (optimal string alignment) — identical to franchise.ts's own local copy,
// duplicated here (rather than lifted into a shared helper) for the exact
// same reason that file gives: so the family-duplicate detection using the
// plain Levenshtein version in hackFamily.ts behaves exactly as before.
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

export interface AuthorSearchHit extends AuthorSummary {
  // The typed query normalizes to exactly this author's own name.
  exact: boolean;
  // Not a substring match, but close enough by edit distance to be worth
  // showing as a "did you mean…" — see searchAuthors.
  similar: boolean;
}

export interface AuthorSearchResult {
  hits: AuthorSearchHit[];
  exactMatch: AuthorSummary | null;
}

// How many authors searchAuthors loads to filter in memory. Sized for a
// catalogue that has been through the legacy-author import (one row per
// distinct credited name — a few thousand at most for a community catalogue),
// not for the handful of rows this was copied from franchises with: at the
// franchise-sized 2000 it would have silently stopped finding anyone past the
// 2000th name alphabetically.
const SEARCH_CANDIDATE_CAP = 10000;

// Searches by name — same shape as searchFranchises (see that function's
// own comment for the full reasoning): an empty query browses (approved
// first, then alphabetical), a typed query ranks substring/word-start
// matches via authorRelevance() and surfaces edit-distance near-misses, and
// the whole candidate list is loaded and filtered in memory rather than
// expressed in SQL, since this is a small table.
export async function searchAuthors(
  client: TxClient,
  q: string | undefined,
  opts: { includePending: boolean; limit: number; excludeId?: string }
): Promise<AuthorSearchResult> {
  const rows: Array<{ id: string; name: string; nameKey: string; status: AuthorStatusValue }> = await client.author.findMany({
    where: opts.includePending ? {} : { status: 'APPROVED' },
    select: { id: true, name: true, nameKey: true, status: true },
    orderBy: { name: 'asc' },
    take: SEARCH_CANDIDATE_CAP,
  });

  const candidates = opts.excludeId ? rows.filter((r) => r.id !== opts.excludeId) : rows;
  const normalized = q ? authorNameKey(q) : '';
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
      const score = authorRelevance(r.name, normalized); // 4 exact, 3 prefix, 2 word-prefix, 1 substring, 0 none
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

  const hits: AuthorSearchHit[] = scored.slice(0, opts.limit).map(({ r, score, similar }) => ({
    id: r.id, name: r.name, status: r.status, exact: score === 4, similar,
  }));
  const exact = scored.find((x) => x.score === 4);
  return {
    hits,
    exactMatch: exact ? { id: exact.r.id, name: exact.r.name, status: exact.r.status } : null,
  };
}

// ─── Assignment (putting authors on an existing submission) ─────────────────

// Validates a proposed ordered list before it's written anywhere — a clean
// 4xx instead of a raw foreign-key violation (a confusing 500) if a row was
// removed or merged away since the picker loaded it. Drops repeats (first
// occurrence wins, so the order the person chose is kept) and refuses more
// than MAX_AUTHORS_PER_SUBMISSION. `client` accepts either the plain prisma
// client (a read-only pre-check) or an open transaction, same trick
// validateFranchiseAssignment/validateBaseRomAssignment use. PENDING is
// allowed — a submission isn't blocked on its authors' own review finishing.
// An empty list is valid (it means "no linked authors") and returns [].
export async function validateAuthorAssignments(client: TxClient, authorIds: string[]): Promise<AuthorSummary[]> {
  const ids: string[] = [];
  for (const id of authorIds) {
    if (typeof id !== 'string' || id === '') {
      throw new AuthorAssignError('Invalid author', 400);
    }
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > MAX_AUTHORS_PER_SUBMISSION) {
    throw new AuthorAssignError(`A hack can credit at most ${MAX_AUTHORS_PER_SUBMISSION} authors.`, 422);
  }
  if (ids.length === 0) return [];

  const rows: Array<{ id: string; name: string; status: string }> = await client.author.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, status: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new AuthorAssignError(
      ids.length === 1
        ? 'That author no longer exists — please pick it again.'
        : 'One of those authors no longer exists — please pick them again.',
      422
    );
  }
  // Re-emit in the REQUESTED order (findMany makes no ordering promise).
  return ids.map((id) => {
    const r = byId.get(id)!;
    return { id: r.id, name: r.name, status: r.status as AuthorStatusValue };
  });
}

// Replaces ONE submission's author links with exactly `targets`, in order
// (position 0, 1, 2…). Writes the join rows only — the caller puts
// authorsCacheString(...) into `author` as part of its own submission write
// (every caller already has one), so this never touches the Submission row
// itself (and so never bumps its updatedAt). An empty list removes every link.
export async function setSubmissionAuthors(tx: TxClient, submissionId: string, targets: AuthorSummary[]): Promise<void> {
  await tx.submissionAuthor.deleteMany({ where: { submissionId } });
  if (targets.length > 0) {
    await tx.submissionAuthor.createMany({
      data: targets.map((t, position) => ({ submissionId, authorId: t.id, position })),
    });
  }
}

// Full-replace author sync to every OTHER version of a hack — same
// "family-shared, propagated at write time" treatment propagateFranchise
// gives franchiseId, EXCEPT this also keeps the `author` string cache in sync
// on every sibling it touches (the joined names, or null when clearing),
// since — unlike franchiseId — there's a second column here that needs to
// keep telling the truth. An empty `targets` clears both on the siblings too.
// A user-driven edit, so (like propagateSharedFields next to it) the sibling
// rows' updatedAt moves — not a bookkeeping job, see refreshAuthorCache for
// those.
export async function propagateAuthors(
  tx: TxClient,
  familyId: string,
  excludeSubmissionId: string,
  targets: AuthorSummary[]
): Promise<void> {
  const siblings: Array<{ id: string }> = await tx.submission.findMany({
    where: { hackFamilyId: familyId, id: { not: excludeSubmissionId } },
    select: { id: true },
  });
  if (siblings.length === 0) return;
  const ids = siblings.map((s) => s.id);

  await tx.submissionAuthor.deleteMany({ where: { submissionId: { in: ids } } });
  if (targets.length > 0) {
    await tx.submissionAuthor.createMany({
      data: ids.flatMap((submissionId) => targets.map((t, position) => ({ submissionId, authorId: t.id, position }))),
    });
  }
  await tx.submission.updateMany({
    where: { id: { in: ids } },
    data: { author: authorsCacheString(targets.map((t) => t.name)) },
  });
}

// Standalone apply step for the change-request approval route — validates,
// writes the links AND the denormalized author string, optionally fans out to
// the rest of the family, and logs. Reads the submission's CURRENT
// hackFamilyId itself instead of trusting a caller-supplied one, same
// reasoning reassignSubmissionFranchise documents (a family reassignment
// earlier in the same approval transaction may have just changed it). The
// direct-edit PATCH route (src/app/api/submissions/[id]/route.ts) doesn't
// use this — it folds the author string into its own already-in-flight
// update, same reasoning franchise.ts documents for reassignSubmissionFranchise.
export async function reassignSubmissionAuthors(
  tx: TxClient,
  submissionId: string,
  authorIds: string[],
  actorId: string,
  applyToFamily: boolean
): Promise<void> {
  const targets = await validateAuthorAssignments(tx, authorIds);

  const current: { hackFamilyId: string | null; authors: Array<{ authorId: string }> } | null = await tx.submission.findUnique({
    where: { id: submissionId },
    select: { hackFamilyId: true, authors: { select: { authorId: true }, orderBy: { position: 'asc' } } },
  });
  if (!current) throw new AuthorAssignError('Submission not found', 404);

  // Server-resolved names, never caller-supplied strings — see this file's
  // top comment on why `author` has to stay an accurate cache.
  await setSubmissionAuthors(tx, submissionId, targets);
  await tx.submission.update({
    where: { id: submissionId },
    data: { author: authorsCacheString(targets.map((t) => t.name)) },
  });

  const fannedOut = applyToFamily && !!current.hackFamilyId;
  if (fannedOut) {
    await propagateAuthors(tx, current.hackFamilyId as string, submissionId, targets);
  }

  await tx.auditLog.create({
    data: {
      action: 'SUBMISSION_AUTHOR_CHANGED',
      details: {
        from: current.authors.map((a) => a.authorId),
        to: targets.map((t) => t.id),
        toNames: targets.map((t) => t.name),
        appliedToAllVersions: fannedOut,
      },
      userId: actorId,
      submissionId,
    },
  });
}

// ─── Keeping the cache honest after bulk author changes ─────────────────────

// Rewrites Submission.author from the CURRENT links for the given submissions
// (or for every submission linked to `authorId` — what a rename needs). Pure
// bookkeeping, so it is a raw UPDATE on purpose: a Prisma update would stamp
// "now" into Submission.updatedAt, which hack-family aggregation reads as
// "most recently edited" (see the updatedAt lesson in CLAUDE_HANDOFF.txt
// section 12). Only submissions that still have at least one link are
// touched — one left with NONE keeps its text, which is the legacy "plain
// text, no link" state, exactly what removing an Author has always done.
// Returns how many rows it rewrote. SQL twin of authorsCacheString(): the
// separator is passed in as a parameter from the same constant.
export async function refreshAuthorCache(
  tx: TxClient,
  scope: { submissionIds: string[] } | { authorId: string }
): Promise<number> {
  if ('submissionIds' in scope) {
    if (scope.submissionIds.length === 0) return 0;
    return tx.$executeRaw`
      UPDATE "Submission" AS s
      SET "author" = agg."names"
      FROM (
        SELECT sa."submissionId" AS "id",
               string_agg(a."name", ${AUTHOR_SEPARATOR}::text ORDER BY sa."position", a."name") AS "names"
        FROM "SubmissionAuthor" sa
        JOIN "Author" a ON a."id" = sa."authorId"
        WHERE sa."submissionId" = ANY(${scope.submissionIds}::text[])
        GROUP BY sa."submissionId"
      ) agg
      WHERE s."id" = agg."id" AND s."author" IS DISTINCT FROM agg."names"`;
  }
  return tx.$executeRaw`
    UPDATE "Submission" AS s
    SET "author" = agg."names"
    FROM (
      SELECT sa."submissionId" AS "id",
             string_agg(a."name", ${AUTHOR_SEPARATOR}::text ORDER BY sa."position", a."name") AS "names"
      FROM "SubmissionAuthor" sa
      JOIN "Author" a ON a."id" = sa."authorId"
      WHERE sa."submissionId" IN (SELECT "submissionId" FROM "SubmissionAuthor" WHERE "authorId" = ${scope.authorId})
      GROUP BY sa."submissionId"
    ) agg
    WHERE s."id" = agg."id" AND s."author" IS DISTINCT FROM agg."names"`;
}

// ─── Merging and deleting (the link-moving halves) ──────────────────────────

// Moves every hack credited to `fromId` over to `intoId` and rebuilds those
// hacks' `author` string. Does NOT delete the "from" Author row or write the
// audit entry — the merge route does that around this, in the same
// transaction. Two cases per hack:
//  - it credits only "from": the link is re-pointed at "into", keeping its
//    position in that hack's order;
//  - it ALREADY credits "into" as well (a hack can credit several authors):
//    the redundant "from" link is dropped instead — (submissionId, authorId)
//    is the primary key, so re-pointing it would collide — and "into" keeps
//    its own place in that hack's order.
// Positions can be left with a gap by that second case; only their ORDER is
// ever read, so that's harmless.
export async function mergeAuthorLinks(
  tx: TxClient,
  fromId: string,
  intoId: string
): Promise<{ affectedIds: string[]; alreadyCreditedTarget: number }> {
  const fromLinks: Array<{ submissionId: string }> = await tx.submissionAuthor.findMany({
    where: { authorId: fromId },
    select: { submissionId: true },
  });
  const affectedIds = fromLinks.map((l) => l.submissionId);

  const alsoHaveTarget: Array<{ submissionId: string }> = affectedIds.length
    ? await tx.submissionAuthor.findMany({
        where: { authorId: intoId, submissionId: { in: affectedIds } },
        select: { submissionId: true },
      })
    : [];
  if (alsoHaveTarget.length > 0) {
    await tx.submissionAuthor.deleteMany({
      where: { authorId: fromId, submissionId: { in: alsoHaveTarget.map((l) => l.submissionId) } },
    });
  }
  await tx.submissionAuthor.updateMany({ where: { authorId: fromId }, data: { authorId: intoId } });

  // Raw UPDATE inside refreshAuthorCache on purpose: bookkeeping, so it must
  // not stamp "now" into Submission.updatedAt.
  await refreshAuthorCache(tx, { submissionIds: affectedIds });
  return { affectedIds, alreadyCreditedTarget: alsoHaveTarget.length };
}

// Deletes an Author row (the database cascades its links away) and rebuilds
// the `author` string of every hack that still has OTHER linked authors, so
// the string never names someone the hack is no longer linked to. A hack that
// credited ONLY this author is skipped by refreshAuthorCache and keeps its
// text (the legacy "plain text, no link" state) — see the DELETE route for
// why. The affected hacks are looked up INSIDE the transaction, right before
// the delete, so a link added a moment earlier can't be missed. Returns how
// many hacks were unlinked.
export async function deleteAuthorAndRefreshCache(tx: TxClient, authorId: string): Promise<number> {
  const links: Array<{ submissionId: string }> = await tx.submissionAuthor.findMany({
    where: { authorId },
    select: { submissionId: true },
  });
  await tx.author.delete({ where: { id: authorId } });
  await refreshAuthorCache(tx, { submissionIds: links.map((l) => l.submissionId) });
  return links.length;
}

// ─── Reading authors back ───────────────────────────────────────────────────

// The Prisma `select` fragment every reader uses to load a submission's
// authors in credit order. Spread it into a select/include:
//   select: { ..., authors: AUTHORS_SELECT }
export const AUTHORS_SELECT = {
  orderBy: { position: 'asc' as const },
  select: { author: { select: { id: true, name: true, status: true } } },
};

export type SubmissionAuthorRow = { author: { id: string; name: string; status: string } };

// Flattens the relation rows AUTHORS_SELECT returns into plain summaries.
export function flattenAuthors(rows: SubmissionAuthorRow[] | null | undefined): AuthorSummary[] {
  return (rows ?? []).map((r) => ({ id: r.author.id, name: r.author.name, status: r.author.status as AuthorStatusValue }));
}

// ─── Change-request proposals ───────────────────────────────────────────────

export interface ProposedAuthor {
  id: string;
  name: string | null;
}

// Reads ChangeRequest.proposedAuthor (a Json column) in either shape it has
// ever been stored in — see the column's comment in prisma/schema.prisma:
//   current: { authors: [{ id, name }, ...] }   (the complete ordered list)
//   legacy:  { id: string | null, name }         (one author, or null = remove)
// Returns null when there is no author proposal at all (column NULL, or a
// value that is neither shape), [] for "remove every linked author", else the
// ordered list. Defensive about junk because it reads stored JSON.
export function normalizeProposedAuthors(raw: unknown): ProposedAuthor[] | null {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.authors)) {
    const out: ProposedAuthor[] = [];
    for (const a of obj.authors) {
      if (a && typeof a === 'object' && typeof (a as any).id === 'string' && (a as any).id !== '') {
        const name = (a as any).name;
        out.push({ id: (a as any).id, name: typeof name === 'string' ? name : null });
      }
    }
    return out;
  }
  if ('id' in obj) {
    if (typeof obj.id === 'string' && obj.id !== '') {
      return [{ id: obj.id, name: typeof obj.name === 'string' ? obj.name : null }];
    }
    return obj.id === null ? [] : null;
  }
  return null;
}

// ─── Filtering by author ────────────────────────────────────────────────────

// The Prisma `where` fragment behind every "show me this author's hacks"
// link (/entries?author=…, /submissions?author=…). An EXACT, case-insensitive
// match on ONE author's name, true when ANY of the hack's linked authors has
// that name — an exact match on the denormalized `author` string alone would
// miss every co-credited hack (its string is "A, B", which never equals "A").
// The second clause keeps matching on the string itself, which is how a hack
// with plain-text-only author (no linked rows) is found, exactly as before.
// Spread it into a Submission-level where; it only adds an `OR` key, so it
// can't clash with a caller that has no OR of its own at that level.
export function submissionAuthorFilter(name: string): Prisma.SubmissionWhereInput {
  return {
    OR: [
      { authors: { some: { author: { name: { equals: name, mode: 'insensitive' } } } } },
      { author: { equals: name, mode: 'insensitive' } },
    ],
  };
}
