'use client';

// src/components/FranchiseFilter.tsx
//
// Franchise filter for the browse pages (/entries, /submissions). A
// dropdown rather than a row of pill buttons like PlatformFilters/
// PatchFilters use: there's a fixed handful of platforms, but franchises
// are an open-ended, growing list that would quickly overflow a pill row.
//
// The option list comes from the server page (getFranchiseFilterOptions in
// src/lib/franchise.ts) as a prop instead of being fetched here, so the
// filter renders immediately with no loading flash and only ever offers
// franchises that would actually return results on that page.
//
// Preserves every other query param and resets `page` — a new filter
// changes the result set, so staying on page 3 of the old one would land
// on an empty or wrong page.

import { useRouter, useSearchParams, usePathname } from 'next/navigation';

interface FranchiseFilterProps {
  options: Array<{ id: string; name: string }>;
  current?: string;
}

export function FranchiseFilter({ options, current }: FranchiseFilterProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function onChange(id: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (id) params.set('franchise', id);
    else params.delete('franchise');
    params.delete('page');
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  if (options.length === 0 && !current) return null;

  return (
    <label className="flex items-center gap-2 text-xs text-text-muted">
      <span className="font-mono uppercase tracking-wider">Franchise</span>
      <select
        value={current ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="max-w-[16rem] px-2.5 py-1.5 rounded-md bg-bg-surface border border-border text-text-primary text-xs focus:border-phosphor/50 transition-colors"
      >
        <option value="">All franchises</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
    </label>
  );
}
