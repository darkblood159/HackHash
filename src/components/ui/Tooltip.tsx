'use client';

// src/components/ui/Tooltip.tsx
//
// Lightweight hover/focus tooltip — no new dependency, just Tailwind +
// plain state. Built for tag descriptions (TagBadge, TagsEditor,
// TagFilters) so a term like "Kaizo/Extreme Difficulty" or "Localization"
// is understandable without leaving the page. Positions above the
// trigger by default; can occasionally clip at the very top of a
// scrolled page — an accepted tradeoff for staying dependency-free rather
// than pulling in a positioning library for something this small.

import React, { useState } from 'react';

interface TooltipProps {
  content?: string | null;
  children: React.ReactNode;
  className?: string;
}

export function Tooltip({ content, children, className }: TooltipProps) {
  const [open, setOpen] = useState(false);

  if (!content) return <>{children}</>;

  return (
    <span
      className={`relative inline-flex ${className ?? ''}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 w-max max-w-[220px] -translate-x-1/2 rounded-md border border-border bg-bg-elevated px-2.5 py-1.5 text-[11px] leading-snug text-text-secondary shadow-lg"
        >
          {content}
        </span>
      )}
    </span>
  );
}
