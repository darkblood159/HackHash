// src/components/ui/TagBadge.tsx
import React from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';
import { Tooltip } from './Tooltip';

interface TagBadgeProps {
  name: string;
  slug: string;
  /** If provided, the badge is a clickable filter link */
  href?: string;
  size?: 'sm' | 'md';
  active?: boolean;
  /** Shown as a hover tooltip when present — see src/lib/tags.ts */
  description?: string | null;
}

export function TagBadge({ name, slug, href, size = 'sm', active, description }: TagBadgeProps) {
  const className = clsx(
    'inline-flex items-center rounded-full border font-medium whitespace-nowrap transition-colors',
    size === 'sm' ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs',
    active
      ? 'bg-phosphor/15 border-phosphor/40 text-phosphor'
      : 'bg-bg-elevated border-border text-text-muted hover:border-phosphor/30 hover:text-text-secondary'
  );

  const badge = href
    ? <Link href={href} className={className}>{name}</Link>
    : <span className={className}>{name}</span>;

  return <Tooltip content={description}>{badge}</Tooltip>;
}
