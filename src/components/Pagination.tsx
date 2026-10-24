// src/components/Pagination.tsx
//
// Previous / numbered / Next links for a paged list. A server component of
// plain <Link>s (no client JS): the page passes a function that builds the
// href for a page number, so each page keeps its own filters in the link.
// Renders nothing when there is only one page.
import Link from 'next/link';
import { pageWindow } from '@/lib/pagination';

const BASE = 'min-w-8 h-8 px-2 flex items-center justify-center rounded-md text-xs font-mono';

export function Pagination({
  page,
  totalPages,
  hrefFor,
}: {
  page: number;
  totalPages: number;
  hrefFor: (p: number) => string;
}) {
  const items = pageWindow(page, totalPages);
  if (items.length === 0) return null;

  return (
    <nav aria-label="Pagination" className="flex flex-wrap justify-center items-center gap-1.5 mt-8">
      {page > 1 ? (
        <Link href={hrefFor(page - 1)} rel="prev" className={`${BASE} text-text-secondary hover:bg-bg-elevated`}>
          ← Prev
        </Link>
      ) : (
        <span aria-disabled="true" className={`${BASE} text-text-muted/50`}>← Prev</span>
      )}
      {items.map((it, i) =>
        it === 'gap' ? (
          <span key={`gap-${i}`} aria-hidden="true" className={`${BASE} text-text-muted`}>…</span>
        ) : (
          <Link
            key={it}
            href={hrefFor(it)}
            aria-current={it === page ? 'page' : undefined}
            className={`${BASE} ${it === page ? 'bg-phosphor text-bg-base' : 'text-text-muted hover:bg-bg-elevated'}`}
          >
            {it}
          </Link>
        ),
      )}
      {page < totalPages ? (
        <Link href={hrefFor(page + 1)} rel="next" className={`${BASE} text-text-secondary hover:bg-bg-elevated`}>
          Next →
        </Link>
      ) : (
        <span aria-disabled="true" className={`${BASE} text-text-muted/50`}>Next →</span>
      )}
    </nav>
  );
}
