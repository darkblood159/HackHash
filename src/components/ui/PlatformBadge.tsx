// src/components/ui/PlatformBadge.tsx
import React from 'react';
import { Gamepad2 } from 'lucide-react';
import { PLATFORM_LABELS, type PlatformValue } from '@/types';

export function PlatformBadge({ platform, size = 'md' }: { platform: string; size?: 'sm' | 'md' }) {
  const label = PLATFORM_LABELS[platform as PlatformValue] ?? platform;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border border-border bg-bg-elevated text-text-secondary font-medium whitespace-nowrap ${
        size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-xs'
      }`}
    >
      <Gamepad2 size={size === 'sm' ? 10 : 11} className="text-phosphor" />
      {label}
    </span>
  );
}
