// src/app/api/search/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { relevanceScore, toISODateOnly } from '@/lib/hackFamily';

// ─── Query normalization ───────────────────────────────────────────────────────
//
// The previous implementation did a single ILIKE substring match against the
// raw query string. This meant:
//   "links awakening"  → couldn't find "Link's Awakening"  (apostrophe mismatch)
//   "zelda ocarina"    → couldn't find "Zelda: Ocarina of Time" if not exact
//   "super mario rpg"  → would only match if those exact chars appeared in sequence
//
// The improved approach:
//   1. Detect hash queries (8/32/40-char hex) and route to exact hash match.
//   2. For text, strip punctuation/special chars and split into individual words.
//   3. Run TWO parallel strategies:
//      a) All-words-must-match AND (handles multi-word queries — "zelda ocarina"
//         finds any entry containing BOTH "zelda" AND "ocarina" anywhere)
//      b) Full normalized string substring match (handles cases where the exact
//         phrase, minus punctuation, appears in the stored value)
//   4. Union the results from both strategies, deduplicating by id.
//
// Note: for "links" → "Link's", the "links" word search won't find "Link's" because
// "links" is not a substring of "Link's". The also-try-without-trailing-s approach
// handles this: "links" → also try "link", which IS a substring of "Link's".

function normalizeQuery(q: string) {
  // Remove everything except letters, digits, and spaces; collapse whitespace
  const normalized = q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = normalized.split(' ').filter((w) => w.length >= 2);
  return { normalized, words };
}

function wordVariants(word: string): string[] {
  const v = [word];
  // "links" → also try "link" (catches possessives like "Link's")
  if (word.endsWith('s') && word.length > 3) v.push(word.slice(0, -1));
  // "running" → also try "run" (poor-man's stemming for -ing)
  if (word.endsWith('ing') && word.length > 5) v.push(word.slice(0, -3));
  return v;
}

// The filters above decide WHICH results match (any substring, anywhere) —
// relevanceScore (src/lib/hackFamily.ts, shared with the autocomplete
// endpoint) decides what order they come back in.

function buildSubmissionTextFilters(q: string, words: string[], normalized: string) {
  // Strategy A: all meaningful words must appear somewhere in the record.
  // Each word-position is a required AND; within each position, any field
  // (hackName, author, description) can satisfy it; within each field, any
  // word variant satisfies it.
  const allWordsFilter =
    words.length >= 2
      ? {
          AND: words.map((word) => ({
            OR: wordVariants(word).flatMap((v) => [
              { hackName: { contains: v, mode: 'insensitive' as const } },
              { author: { contains: v, mode: 'insensitive' as const } },
              { description: { contains: v, mode: 'insensitive' as const } },
            ]),
          })),
        }
      : null;

  // Strategy B: full normalized string as a substring.
  const fullStringFilter = {
    OR: [
      { hackName: { contains: normalized, mode: 'insensitive' as const } },
      { hackName: { contains: q, mode: 'insensitive' as const } },
      { author: { contains: normalized, mode: 'insensitive' as const } },
      { author: { contains: q, mode: 'insensitive' as const } },
      { description: { contains: normalized, mode: 'insensitive' as const } },
    ],
  };

  return allWordsFilter ? [allWordsFilter, fullStringFilter] : [fullStringFilter];
}

function buildEntryTextFilters(q: string, normalized: string, words: string[]) {
  const allWordsFilter =
    words.length >= 2
      ? {
          AND: words.map((word) => ({
            OR: wordVariants(word).map((v) => ({
              machineName: { contains: v, mode: 'insensitive' as const },
            })),
          })),
        }
      : null;

  const fullStringFilter = {
    OR: [
      { machineName: { contains: q, mode: 'insensitive' as const } },
      { machineName: { contains: normalized, mode: 'insensitive' as const } },
      { description: { contains: normalized, mode: 'insensitive' as const } },
    ],
  };

  return allWordsFilter ? [allWordsFilter, fullStringFilter] : [fullStringFilter];
}

// Collapses "Database entries" results down to one per hack family, same as
// the /entries browse page — otherwise every version of a hack shows up as
// its own separate search result. Dedup above already orders results with
// the most relevant match first, so the first member of each family group
// is used as the representative rather than re-deriving relevance here.
function groupEntriesByFamily(entries: any[]): any[] {
  const byFamily = new Map<string, any[]>();
  for (const e of entries) {
    const key = e.submission?.hackFamilyId ?? `single:${e.id}`;
    const list = byFamily.get(key) ?? [];
    list.push(e);
    byFamily.set(key, list);
  }
  return Array.from(byFamily.values()).map((members) => {
    const representative = members[0];
    const familyName = representative.submission?.hackFamily?.name;
    const cleanName = familyName ?? representative.submission?.hackName ?? representative.machineName;
    // One place to fix the Date→string shape for all three call sites
    // below, same 'YYYY-MM-DD' wire format used everywhere else a release
    // date crosses an API boundary (see toISODateOnly's comment).
    const submission = representative.submission
      ? { ...representative.submission, releaseDate: toISODateOnly(representative.submission.releaseDate) }
      : representative.submission;
    return { ...representative, submission, machineName: cleanName, versionCount: members.length };
  });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q')?.trim();
  const type = searchParams.get('type') ?? 'all';
  const platform = searchParams.get('platform') ?? undefined;

  if (!q || q.length < 2) {
    return NextResponse.json({ submissions: [], entries: [], users: [] });
  }

  const { normalized, words } = normalizeQuery(q);

  // Hash detection: if the query looks like a full hash, skip text search
  const isHash8  = /^[0-9a-f]{8}$/i.test(q);
  const isHash32 = /^[0-9a-f]{32}$/i.test(q);
  const isHash40 = /^[0-9a-f]{40}$/i.test(q);
  const hashCondition = isHash40 ? { sha1: q.toLowerCase() }
    : isHash32 ? { md5: q.toLowerCase() }
    : isHash8  ? { crc32: q.toLowerCase() }
    : null;

  if (hashCondition) {
    // Exact hash lookup — no fuzzy needed
    const [submissions, entries] = await Promise.all([
      type !== 'entries'
        ? prisma.submission.findMany({
            where: {
              ...hashCondition, deletedAt: null,
              // Approved submissions already show up under "Database
              // entries" (they have their own ApprovedEntry row) — showing
              // them again here under "Submissions" is pure redundancy.
              status: { not: 'APPROVED' },
              ...(platform ? { platform: platform as any } : {}),
            },
            select: {
              id: true, hackName: true, version: true, author: true, platform: true,
              status: true, verificationScore: true, sha1: true, crc32: true,
              tags: { select: { tag: { select: { id: true, name: true, slug: true, description: true } } } },
            },
            orderBy: { verificationScore: 'desc' },
            take: 50,
          })
        : [],
      type !== 'submissions'
        ? prisma.approvedEntry.findMany({
            where: { ...hashCondition, submission: { deletedAt: null }, ...(platform ? { platform: platform as any } : {}) },
            select: {
              id: true, submissionId: true, machineName: true, crc32: true, sha1: true, platform: true,
              submission: { select: { hackName: true, author: true, releaseYear: true, releaseDate: true, hackFamilyId: true, hackFamily: { select: { name: true } } } },
            },
            take: 50,
          })
        : [],
    ]);
    return NextResponse.json({ submissions, entries: groupEntriesByFamily(entries), query: q, mode: 'hash' });
  }

  // Text search — run both strategies in parallel and merge
  const subFilters = buildSubmissionTextFilters(q, words, normalized);
  const entFilters = buildEntryTextFilters(q, normalized, words);

  const platformFilter: Record<string, unknown> = platform ? { platform: platform as any } : {};
  // ApprovedEntry has no deletedAt column of its own — a deleted submission's
  // live DAT entry is filtered out via the relation instead.
  const entryPlatformFilter: Record<string, unknown> = { ...platformFilter, submission: { deletedAt: null } };
  // Approved submissions are excluded here for the same reason as the hash-
  // search path above — they're already shown under "Database entries",
  // showing them again under "Submissions" is pure redundancy.
  const subPlatformFilter: Record<string, unknown> = { ...platformFilter, deletedAt: null, status: { not: 'APPROVED' } };

  const [subResultsA, subResultsB, entResultsA, entResultsB] = await Promise.all([
    type !== 'entries' && subFilters[0]
      ? prisma.submission.findMany({
          where: { ...subFilters[0], ...subPlatformFilter },
          select: {
            id: true, hackName: true, version: true, author: true, platform: true,
            status: true, verificationScore: true, sha1: true, crc32: true,
            tags: { select: { tag: { select: { id: true, name: true, slug: true, description: true } } } },
          },
          orderBy: { verificationScore: 'desc' },
          take: 50,
        })
      : [],
    type !== 'entries' && subFilters[1]
      ? prisma.submission.findMany({
          where: { ...subFilters[1], ...subPlatformFilter },
          select: {
            id: true, hackName: true, version: true, author: true, platform: true,
            status: true, verificationScore: true, sha1: true, crc32: true,
            tags: { select: { tag: { select: { id: true, name: true, slug: true, description: true } } } },
          },
          orderBy: { verificationScore: 'desc' },
          take: 50,
        })
      : [],
    type !== 'submissions' && entFilters[0]
      ? prisma.approvedEntry.findMany({
          where: { ...entFilters[0], ...entryPlatformFilter },
          select: {
            id: true, submissionId: true, machineName: true, crc32: true, sha1: true, platform: true,
            submission: { select: { hackName: true, author: true, releaseYear: true, releaseDate: true, hackFamilyId: true, hackFamily: { select: { name: true } } } },
          },
          take: 50,
        })
      : [],
    type !== 'submissions' && entFilters[1]
      ? prisma.approvedEntry.findMany({
          where: { ...entFilters[1], ...entryPlatformFilter },
          select: {
            id: true, submissionId: true, machineName: true, crc32: true, sha1: true, platform: true,
            submission: { select: { hackName: true, author: true, releaseYear: true, releaseDate: true, hackFamilyId: true, hackFamily: { select: { name: true } } } },
          },
          take: 50,
        })
      : [],
  ]);

  // Deduplicate by id, preserving order (strategy A results first — more precise)
  const seen = new Set<string>();
  const submissions = [...(subResultsA as any[]), ...(subResultsB as any[])].filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
  submissions.sort((a, b) => relevanceScore(b.hackName, normalized) - relevanceScore(a.hackName, normalized));

  const seenEnt = new Set<string>();
  const entries = [...(entResultsA as any[]), ...(entResultsB as any[])].filter((e) => {
    if (seenEnt.has(e.id)) return false;
    seenEnt.add(e.id);
    return true;
  });
  entries.sort((a, b) => relevanceScore(b.machineName, normalized) - relevanceScore(a.machineName, normalized));

  return NextResponse.json({
    submissions: submissions.slice(0, 50),
    entries: groupEntriesByFamily(entries).slice(0, 50),
    query: q, mode: 'text', words,
  });
}
