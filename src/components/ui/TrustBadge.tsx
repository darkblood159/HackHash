// src/components/ui/TrustBadge.tsx
import React from 'react';
import { clsx } from 'clsx';
import { Shield, ShieldCheck, ShieldAlert } from 'lucide-react';
import { TRUST_TIER_THRESHOLDS } from '@/types';

export function getTrustTier(score: number): 'new' | 'trusted' | 'veteran' {
  if (score >= TRUST_TIER_THRESHOLDS.VETERAN) return 'veteran';
  if (score >= TRUST_TIER_THRESHOLDS.TRUSTED) return 'trusted';
  return 'new';
}

const TIER_CONFIG = {
  new: { label: 'New', icon: Shield, color: 'text-text-secondary', weight: 1 },
  trusted: { label: 'Trusted', icon: ShieldCheck, color: 'text-status-verified', weight: 3 },
  veteran: { label: 'Veteran', icon: ShieldAlert, color: 'text-phosphor', weight: 10 },
} as const;

export function TrustBadge({ score, showWeight = false }: { score: number; showWeight?: boolean }) {
  const tier = getTrustTier(score);
  const config = TIER_CONFIG[tier];
  const Icon = config.icon;

  return (
    <span className={clsx('inline-flex items-center gap-1 text-xs font-medium', config.color)}>
      <Icon size={12} />
      <span className="font-numeric">{score}</span>
      {showWeight && <span className="text-text-muted">· ×{config.weight}</span>}
    </span>
  );
}
