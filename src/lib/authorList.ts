// src/lib/authorList.ts
//
// The client-safe half of the multi-author feature: constants and the one
// pure helper that browser components AND src/lib/author.ts (which pulls in
// server-side code) both need. Zero imports on purpose — same convention as
// patchUploadState.ts / syncConfig.ts: a 'use client' component must not
// import straight from a file that reaches Prisma. author.ts re-exports all
// of this, so server code can keep importing from there.

// Soft abuse / sanity cap on how many authors one submission can credit. A
// real team credit rarely goes past a handful; the cap exists so a malformed
// or hostile request can't attach hundreds of rows to one hack (and so the
// joined `author` display string stays a sensible length).
export const MAX_AUTHORS_PER_SUBMISSION = 10;

// What joins the names in the denormalized Submission.author string. The ONE
// definition of the separator: authorsCacheString() (TypeScript) and
// refreshAuthorCache() in author.ts (SQL string_agg) both use it, so the two
// ways of building the string can't disagree.
export const AUTHOR_SEPARATOR = ', ';

// The denormalized Submission.author string for an ordered list of names, or
// null for none. (A single author's string is just that author's name,
// exactly what the old one-author cache held.)
export function authorsCacheString(names: string[]): string | null {
  return names.length ? names.join(AUTHOR_SEPARATOR) : null;
}
