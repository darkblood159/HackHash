'use client';

// src/components/SubmissionFilters.tsx
import React from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { clsx } from 'clsx';

const FILTERS = [
  { value: undefined, label: 'All' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'COMMUNITY_VERIFIED', label: 'Community Verified' },
  { value: 'RECOMMENDED', label: 'Recommended' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'DISPUTED', label: 'Disputed' },
  { value: 'REJECTED', label: 'Rejected' },
];

export function SubmissionFilters({ current }: { current?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const setStatus = (status?: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (status) {
      params.set('status', status);
    } else {
      params.delete('status');
    }
    router.push(`${pathname}?${params.toString()}`);
  };

  return (
    <div className="flex flex-wrap gap-1.5">
      {FILTERS.map((f) => (
        <button
          key={f.label}
          onClick={() => setStatus(f.value)}
          className={clsx(
            'px-3 py-1.5 rounded-full text-xs font-medium border transition-colors',
            current === f.value
              ? 'bg-phosphor/15 border-phosphor/40 text-phosphor'
              : 'bg-bg-surface border-border text-text-secondary hover:border-phosphor/30'
          )}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}
