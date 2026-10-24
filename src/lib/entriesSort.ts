// src/lib/entriesSort.ts
//
// Sort options for /entries (the Database page), as a zero-import module so
// the page, the dropdown and the tests all read ONE list. The URL param is
// `?sort=<value>`; the default (name) is never written to the URL, so every
// existing /entries link keeps meaning exactly what it did.
//
// /entries groups approved versions into hack families BEFORE paginating
// (see the page's own comment), so every option here sorts FAMILIES, and
// the date-based ones look at the whole family, not just the one version
// the row happens to display:
//   approved - the family's most recently approved version
//   updated  - the family's most recently touched version, by Submission.updatedAt.
//              That column is `@updatedAt`, so ANY Prisma update to the row moves
//              it: an edit, an approval/status change, and every vote
//              (recalculateVerificationScore in src/lib/trust.ts is a plain
//              prisma.submission.update). Raw-SQL bookkeeping writes (e.g.
//              markHasheousChecked) do not. So this means "recent activity",
//              not strictly "recently edited".
//   release  - the family's newest release (a full releaseDate when a version
//              has one, else releaseYear counted as 1 January of that year).
//              Families with no release info at all always sort LAST, in
//              either direction of reading, so they never crowd the top.

export const ENTRIES_SORTS = ['name', 'name_desc', 'approved', 'updated', 'release'] as const;
export type EntriesSort = (typeof ENTRIES_SORTS)[number];

export const DEFAULT_ENTRIES_SORT: EntriesSort = 'name';

export const ENTRIES_SORT_LABELS: Record<EntriesSort, string> = {
  name: 'Name (A–Z)',
  name_desc: 'Name (Z–A)',
  approved: 'Recently approved',
  updated: 'Recently updated',
  release: 'Newest release',
};

/** Anything that is not exactly one of the known values falls back to the default. */
export function parseEntriesSort(value: unknown): EntriesSort {
  return typeof value === 'string' && (ENTRIES_SORTS as readonly string[]).includes(value)
    ? (value as EntriesSort)
    : DEFAULT_ENTRIES_SORT;
}

/** The per-family numbers the comparator needs (epoch ms; null = unknown). */
export interface SortableGroup {
  displayName: string;
  latestApprovedAt: number;
  latestUpdatedAt: number;
  latestRelease: number | null;
}

/** One version's contribution to a family's sort keys. */
export interface SortableMember {
  approvedAt: Date | string;
  updatedAt: Date | string;
  releaseDate: Date | string | null;
  releaseYear: number | null;
}

function toMs(d: Date | string): number {
  return new Date(d).getTime();
}

function releaseMs(m: Pick<SortableMember, 'releaseDate' | 'releaseYear'>): number | null {
  if (m.releaseDate) return toMs(m.releaseDate);
  if (m.releaseYear != null) return Date.UTC(m.releaseYear, 0, 1);
  return null;
}

/** Folds a family's versions into the three keys above (max of each). */
export function summarizeMembers(members: SortableMember[]): Pick<SortableGroup, 'latestApprovedAt' | 'latestUpdatedAt' | 'latestRelease'> {
  let latestApprovedAt = -Infinity;
  let latestUpdatedAt = -Infinity;
  let latestRelease: number | null = null;
  for (const m of members) {
    latestApprovedAt = Math.max(latestApprovedAt, toMs(m.approvedAt));
    latestUpdatedAt = Math.max(latestUpdatedAt, toMs(m.updatedAt));
    const r = releaseMs(m);
    if (r !== null && (latestRelease === null || r > latestRelease)) latestRelease = r;
  }
  return { latestApprovedAt, latestUpdatedAt, latestRelease };
}

const byName = (a: SortableGroup, b: SortableGroup) => a.displayName.localeCompare(b.displayName);

/**
 * Comparator for Array.prototype.sort. Ties always fall back to name A-Z
 * (and then to the input order, since sort is stable), so a page boundary
 * can never shuffle between two loads of the same list.
 * 'name' is exactly the comparator the page used before this existed.
 */
export function compareGroups(sort: EntriesSort, a: SortableGroup, b: SortableGroup): number {
  switch (sort) {
    case 'name_desc':
      return byName(b, a);
    case 'approved':
      return b.latestApprovedAt - a.latestApprovedAt || byName(a, b);
    case 'updated':
      return b.latestUpdatedAt - a.latestUpdatedAt || byName(a, b);
    case 'release': {
      if (a.latestRelease === null && b.latestRelease === null) return byName(a, b);
      if (a.latestRelease === null) return 1; // undated last
      if (b.latestRelease === null) return -1;
      return b.latestRelease - a.latestRelease || byName(a, b);
    }
    case 'name':
    default:
      return byName(a, b);
  }
}
