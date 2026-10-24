// src/lib/submissionSearch.ts
//
// The text filter on /submissions (`?q=`). One module so the page and the
// search box agree on how a query is cleaned and what it matches.
//
// It matches the same things a person sees on a submission card, plus the
// hashes: hack name, any credited author (Submission.author is the cache of
// the linked authors' names, so one `contains` finds either name in "A, B"),
// the hack family's name, the base ROM's name, and - only when the text
// looks like a hash (6-40 hex characters) - the file's SHA-1/MD5/CRC32. The
// hash match is skipped for ordinary words so typing "dead" or "face"
// doesn't light up unrelated rows whose hash happens to contain it.
// Case-insensitive `contains`, like /entries' own search.
import type { Prisma } from '@prisma/client';

/** Longest query we act on; longer pasted text is cut, not rejected. */
export const MAX_SUBMISSION_QUERY_LENGTH = 100;

const HASH_LIKE = /^[0-9a-f]{6,40}$/i;

/** Trims, collapses inner whitespace, caps the length. Empty -> undefined (no filter). */
export function parseSubmissionQuery(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_SUBMISSION_QUERY_LENGTH).trim();
  return cleaned || undefined;
}

export function buildSubmissionSearchWhere(q: string): Prisma.SubmissionWhereInput {
  // Annotated on the array itself, not left to inference: this mixes scalar
  // filters with relation filters, the exact shape the /entries page's
  // comment warns can pass a loose stub but fail a real `next build`.
  const conditions: Prisma.SubmissionWhereInput[] = [
    { hackName: { contains: q, mode: 'insensitive' } },
    { author: { contains: q, mode: 'insensitive' } },
    { hackFamily: { is: { name: { contains: q, mode: 'insensitive' } } } },
    { baseRom: { is: { name: { contains: q, mode: 'insensitive' } } } },
  ];
  if (HASH_LIKE.test(q)) {
    const h = q.toLowerCase();
    conditions.push(
      { sha1: { contains: h, mode: 'insensitive' } },
      { md5: { contains: h, mode: 'insensitive' } },
      { crc32: { contains: h, mode: 'insensitive' } },
    );
  }
  // Wrapped as AND:[{OR}] on purpose, NOT a bare { OR }: this object is
  // spread into the page's where next to submissionAuthorFilter(), which
  // already owns the top-level `OR` key. Two spreads onto one key silently
  // keep only the later one, so a bare OR here would drop either the author
  // filter or this text filter whenever both are active. AND is unused at
  // that level, so nothing can clash.
  return { AND: [{ OR: conditions }] };
}
