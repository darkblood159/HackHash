// src/components/ui/StatusBadge.tsx
import React from 'react';
import { clsx } from 'clsx';
import { Clock, CheckCircle2, Star, BadgeCheck, XCircle, AlertTriangle } from 'lucide-react';

const STATUS_CONFIG = {
  PENDING: { label: 'Pending', icon: Clock, color: 'text-status-pending', bg: 'bg-status-pending-bg', border: 'border-status-pending/30' },
  COMMUNITY_VERIFIED: { label: 'Community Verified', icon: CheckCircle2, color: 'text-status-verified', bg: 'bg-status-verified-bg', border: 'border-status-verified/30' },
  RECOMMENDED: { label: 'Recommended', icon: Star, color: 'text-status-recommended', bg: 'bg-status-recommended-bg', border: 'border-status-recommended/30' },
  APPROVED: { label: 'Approved', icon: BadgeCheck, color: 'text-status-approved', bg: 'bg-status-approved-bg', border: 'border-status-approved/30' },
  REJECTED: { label: 'Rejected', icon: XCircle, color: 'text-status-rejected', bg: 'bg-status-rejected-bg', border: 'border-status-rejected/30' },
  DISPUTED: { label: 'Disputed', icon: AlertTriangle, color: 'text-status-disputed', bg: 'bg-status-disputed-bg', border: 'border-status-disputed/30' },
} as const;

export function StatusBadge({ status, size = 'md' }: { status: string; size?: 'sm' | 'md' }) {
  const config = STATUS_CONFIG[status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.PENDING;
  const Icon = config.icon;

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border font-medium whitespace-nowrap',
        config.color, config.bg, config.border,
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs'
      )}
    >
      <Icon size={size === 'sm' ? 11 : 12} />
      {config.label}
    </span>
  );
}
