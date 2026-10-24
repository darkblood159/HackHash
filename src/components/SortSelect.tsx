'use client';

// src/components/SortSelect.tsx
//
// Generic "Sort by" dropdown for list pages (/entries, /submissions). A
// native <select> rather than a pill row: the filter pills above it are
// already pill rows, extra pills would push the list down a phone screen,
// and a native select gets the phone's own picker for free. Same shape as
// FranchiseFilter.
//
// Keeps every other query param, drops `page` (a new order makes the old
// page number meaningless), and leaves the DEFAULT sort out of the URL so an
// untouched page keeps its clean link.
import { useRouter, useSearchParams, usePathname } from 'next/navigation';

export interface SortOption {
  value: string;
  label: string;
}

export function SortSelect({
  current,
  options,
  defaultValue,
}: {
  current: string;
  options: SortOption[];
  defaultValue: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function onChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value && value !== defaultValue) params.set('sort', value);
    else params.delete('sort');
    params.delete('page');
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <label className="flex items-center gap-2 text-xs text-text-muted">
      <span className="font-mono uppercase tracking-wider">Sort by</span>
      <select
        value={current}
        onChange={(e) => onChange(e.target.value)}
        className="px-2.5 py-1.5 rounded-md bg-bg-surface border border-border text-text-primary text-xs focus:border-phosphor/50 transition-colors"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}
