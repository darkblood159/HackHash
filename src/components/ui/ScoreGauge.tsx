// src/components/ui/ScoreGauge.tsx
import React from 'react';
import { clsx } from 'clsx';

export function ScoreGauge({ score, threshold1 = 5, threshold2 = 15 }: { score: number; threshold1?: number; threshold2?: number }) {
  const color =
    score < 0 ? 'text-status-disputed' :
    score >= threshold2 ? 'text-status-recommended' :
    score >= threshold1 ? 'text-status-verified' :
    'text-status-pending';

  const max = threshold2 * 1.3;
  const pct = Math.max(0, Math.min(100, ((score + Math.abs(Math.min(0, score))) / max) * 100));

  return (
    <div className="flex items-center gap-2">
      <div className="relative w-16 h-1.5 bg-bg-elevated rounded-full overflow-hidden">
        <div
          className={clsx('h-full rounded-full transition-all', {
            'bg-status-disputed': score < 0,
            'bg-status-recommended': score >= threshold2,
            'bg-status-verified': score >= threshold1 && score < threshold2,
            'bg-status-pending': score >= 0 && score < threshold1,
          })}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={clsx('font-numeric text-sm font-semibold', color)}>
        {score > 0 ? '+' : ''}{score}
      </span>
    </div>
  );
}
