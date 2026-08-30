'use client';

// src/components/TagFilters.tsx
import React, { useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { clsx } from 'clsx';
import { SIMPLE_TAGS, ADVANCED_TAG_GROUPS, type TagDefinition } from '@/lib/tags';
import { Tooltip } from './ui/Tooltip';

export function TagFilters({ current }: { current?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Starts open automatically if the currently-active filter is an
  // advanced-only tag, so following a link to a filtered view never
  // hides which pill is actually selected.
  const [advanced, setAdvanced] = useState(
    () => !!current && !SIMPLE_TAGS.some((t) => t.slug === current)
  );

  const setTag = (slug?: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (slug) {
      params.set('tag', slug);
    } else {
      params.delete('tag');
    }
    router.push(`${pathname}?${params.toString()}`);
  };

  const pillClass = (active: boolean) =>
    clsx(
      'px-2.5 py-1 rounded-full text-xs font-medium border transition-colors',
      active
        ? 'bg-phosphor/15 border-phosphor/40 text-phosphor'
        : 'bg-bg-surface border-border text-text-secondary hover:border-phosphor/30'
    );

  const Pill = ({ tag }: { tag: TagDefinition }) => (
    <Tooltip content={tag.description}>
      <button type="button" onClick={() => setTag(tag.slug)} className={pillClass(current === tag.slug)}>
        {tag.name}
      </button>
    </Tooltip>
  );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => setTag(undefined)} className={pillClass(!current)}>
          All tags
        </button>
        {SIMPLE_TAGS.map((t) => <Pill key={t.slug} tag={t} />)}
        <button
          type="button"
          onClick={() => setAdvanced((a) => !a)}
          className="px-2.5 py-1 rounded-full text-xs font-medium border border-dashed border-border text-text-muted hover:border-phosphor/30 hover:text-text-secondary transition-colors"
        >
          {advanced ? 'Fewer tags ▴' : 'More tags ▾'}
        </button>
      </div>

      {advanced && (
        <div className="mt-2 space-y-2 border-t border-border pt-2">
          {ADVANCED_TAG_GROUPS.map(({ group, tags }) => (
            <div key={group}>
              <p className="text-[10px] uppercase tracking-wider text-text-muted mb-1">{group}</p>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((t) => <Pill key={t.slug} tag={t} />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
