'use client';

// src/components/PlatformFilters.tsx
import React from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { clsx } from 'clsx';
import { PLATFORMS, PLATFORM_LABELS } from '@/types';

export function PlatformFilters({ current }: { current?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const setPlatform = (platform?: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (platform) {
      params.set('platform', platform);
    } else {
      params.delete('platform');
    }
    router.push(`${pathname}?${params.toString()}`);
  };

  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        onClick={() => setPlatform(undefined)}
        className={clsx(
          'px-3 py-1.5 rounded-full text-xs font-medium border transition-colors',
          !current
            ? 'bg-phosphor/15 border-phosphor/40 text-phosphor'
            : 'bg-bg-surface border-border text-text-secondary hover:border-phosphor/30'
        )}
      >
        All platforms
      </button>
      {PLATFORMS.map((p) => (
        <button
          key={p}
          onClick={() => setPlatform(p)}
          className={clsx(
            'px-3 py-1.5 rounded-full text-xs font-medium border transition-colors',
            current === p
              ? 'bg-phosphor/15 border-phosphor/40 text-phosphor'
              : 'bg-bg-surface border-border text-text-secondary hover:border-phosphor/30'
          )}
        >
          {PLATFORM_LABELS[p]}
        </button>
      ))}
    </div>
  );
}
