'use client';

// src/components/PatchFilters.tsx
//
// Three-way "has a patch file been uploaded" filter, shared between
// /submissions (the review queue) and /entries (the database) — same
// `?hasPatch=yes|no` param either place, so a link from one page's filtered
// view to the other keeps meaning the same thing. Reads patchUploadedAt
// (Submission), not patchType/patchFilename/patchSha1 — those three can be
// filled in for a submission that only links out to an externally-hosted
// patch with no file actually stored here (see the field's own comment in
// prisma/schema.prisma); patchUploadedAt is the one true "a file is
// actually attached" flag.
//
// Deliberately its own small component rather than folded into
// PlatformFilters/TagFilters — same "one filter type per file" shape this
// project already uses (PlatformFilters, TagFilters, SubmissionFilters are
// all separate too), and it needs its own three labels rather than
// reusing any existing list.
import React from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { clsx } from 'clsx';

export function PatchFilters({ current }: { current?: 'yes' | 'no' }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const setHasPatch = (value?: 'yes' | 'no') => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set('hasPatch', value);
    } else {
      params.delete('hasPatch');
    }
    router.push(`${pathname}?${params.toString()}`);
  };

  const options: Array<{ value?: 'yes' | 'no'; label: string }> = [
    { value: undefined, label: 'Any patch status' },
    { value: 'yes', label: 'Patch uploaded' },
    { value: 'no', label: 'No patch yet' },
  ];

  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => (
        <button
          key={opt.label}
          onClick={() => setHasPatch(opt.value)}
          className={clsx(
            'px-3 py-1.5 rounded-full text-xs font-medium border transition-colors',
            current === opt.value
              ? 'bg-phosphor/15 border-phosphor/40 text-phosphor'
              : 'bg-bg-surface border-border text-text-secondary hover:border-phosphor/30'
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
