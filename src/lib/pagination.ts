// src/lib/pagination.ts
//
// Pure helpers for paged list pages (zero imports so tests can load them).

/** Positive integer from a ?page= value; anything else (missing, 0, negative, "abc", "1e3", "2.5") is page 1. */
export function parsePageParam(raw: unknown): number {
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) return 1;
  const n = parseInt(raw, 10);
  return n >= 1 ? n : 1;
}

/** Total pages for `total` rows (always at least 1, so an empty list is "page 1 of 1"). */
export function totalPagesFor(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * Which page buttons to show: first, last, and `radius` either side of the
 * current page, with 'gap' standing in for a skipped run. A gap that would
 * hide exactly ONE page shows that page instead (an ellipsis for a single
 * number is longer than the number). Returns [] when there is only one page.
 */
export function pageWindow(current: number, totalPages: number, radius = 2): Array<number | 'gap'> {
  if (totalPages <= 1) return [];
  const keep = new Set<number>([1, totalPages]);
  for (let p = current - radius; p <= current + radius; p++) {
    if (p >= 1 && p <= totalPages) keep.add(p);
  }
  const sorted = Array.from(keep).sort((a, b) => a - b);
  const out: Array<number | 'gap'> = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0) {
      const diff = sorted[i] - sorted[i - 1];
      if (diff === 2) out.push(sorted[i] - 1);
      else if (diff > 2) out.push('gap');
    }
    out.push(sorted[i]);
  }
  return out;
}
