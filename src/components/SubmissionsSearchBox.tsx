'use client';

// src/components/SubmissionsSearchBox.tsx
//
// Text filter for /submissions. Submit-on-Enter (no live typeahead: the
// list is a filtered view of the queue, not a jump-to-entry search like
// /entries' box). Keeps every other active filter in the URL and drops
// `page`, so searching from page 3 doesn't land on an empty page. The
// status/platform/tag/etc. pills copy the whole query string, so they keep
// `q` on their own.
import { useEffect, useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Search, X } from 'lucide-react';
import { MAX_SUBMISSION_QUERY_LENGTH } from '@/lib/submissionSearch';

export function SubmissionsSearchBox({ initialQuery }: { initialQuery?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(initialQuery ?? '');

  // Back/forward and "Clear" links change the URL without remounting this
  // box, so follow the URL instead of keeping a stale typed value.
  useEffect(() => {
    setValue(initialQuery ?? '');
  }, [initialQuery]);

  const apply = (next: string) => {
    const params = new URLSearchParams(searchParams.toString());
    const trimmed = next.replace(/\s+/g, ' ').trim();
    if (trimmed) params.set('q', trimmed);
    else params.delete('q');
    params.delete('page');
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  return (
    <form
      className="relative"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        apply(value);
      }}
    >
      <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
      <input
        name="q"
        type="search"
        autoComplete="off"
        value={value}
        maxLength={MAX_SUBMISSION_QUERY_LENGTH}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Filter by hack name, author, base ROM, or hash…"
        aria-label="Filter submissions by text"
        className="w-full pl-10 pr-10 py-2.5 rounded-lg bg-bg-surface border border-border text-sm placeholder:text-text-muted focus:border-phosphor/50"
      />
      {(value || initialQuery) && (
        <button
          type="button"
          onClick={() => {
            setValue('');
            apply('');
          }}
          aria-label="Clear text filter"
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-text-muted hover:text-phosphor"
        >
          <X size={14} />
        </button>
      )}
    </form>
  );
}
