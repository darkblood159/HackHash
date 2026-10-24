// src/lib/submissionsSort.ts
//
// Sort options for /submissions (the review queue), as a small module so the
// page and the dropdown read ONE list. URL param: `?sort=<value>`. The
// default (`score`) is the order this page has always used and is never
// written to the URL, so every existing link keeps meaning what it did.
//
//   score     - highest verification score first, newest first on ties (the
//               original and still-default order)
//   newest    - most recently submitted first
//   oldest    - least recently submitted first (the natural order for working
//               through a pending queue)
//   activity  - most recent change first, by Submission.updatedAt. NOTE what
//               that really means: it is `@updatedAt`, so ANY Prisma update
//               to the row moves it - an edit, an approval/status change, and
//               every vote (recalculateVerificationScore in src/lib/trust.ts
//               is a plain prisma.submission.update). It is "recent activity",
//               not "recently edited". Hence the label.
//   name      - hack name A-Z / Z-A, using the DATABASE's own ordering
//               (collation), so case/accent handling follows how Postgres
//               was initialised rather than JavaScript's localeCompare.
//
// Every order ends in `id` so two rows that tie on everything else still have
// ONE fixed position; without it, skip/take paging can show a row twice or
// never show it when the ties straddle a page boundary.
import type { Prisma } from '@prisma/client';

export const SUBMISSIONS_SORTS = ['score', 'newest', 'oldest', 'activity', 'name', 'name_desc'] as const;
export type SubmissionsSort = (typeof SUBMISSIONS_SORTS)[number];

export const DEFAULT_SUBMISSIONS_SORT: SubmissionsSort = 'score';

export const SUBMISSIONS_SORT_LABELS: Record<SubmissionsSort, string> = {
  score: 'Highest verified',
  newest: 'Newest submitted',
  oldest: 'Oldest submitted',
  activity: 'Recent activity',
  name: 'Name (A–Z)',
  name_desc: 'Name (Z–A)',
};

/** Anything that is not exactly one of the known values falls back to the default. */
export function parseSubmissionsSort(value: unknown): SubmissionsSort {
  return typeof value === 'string' && (SUBMISSIONS_SORTS as readonly string[]).includes(value)
    ? (value as SubmissionsSort)
    : DEFAULT_SUBMISSIONS_SORT;
}

export function submissionsOrderBy(sort: SubmissionsSort): Prisma.SubmissionOrderByWithRelationInput[] {
  switch (sort) {
    case 'newest':
      return [{ createdAt: 'desc' }, { id: 'asc' }];
    case 'oldest':
      return [{ createdAt: 'asc' }, { id: 'asc' }];
    case 'activity':
      return [{ updatedAt: 'desc' }, { id: 'asc' }];
    case 'name':
      return [{ hackName: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }];
    case 'name_desc':
      return [{ hackName: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }];
    case 'score':
    default:
      return [{ verificationScore: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }];
  }
}
