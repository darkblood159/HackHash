// src/app/about/trust/page.tsx
import React from 'react';
import { TRUST_TIER_THRESHOLDS } from '@/types';

const TIERS = [
  { name: 'New', range: `0 – ${TRUST_TIER_THRESHOLDS.TRUSTED - 1}`, weight: '×1', color: 'text-text-secondary' },
  { name: 'Trusted', range: `${TRUST_TIER_THRESHOLDS.TRUSTED} – ${TRUST_TIER_THRESHOLDS.VETERAN - 1}`, weight: '×3', color: 'text-status-verified' },
  { name: 'Veteran', range: `${TRUST_TIER_THRESHOLDS.VETERAN}+`, weight: '×10', color: 'text-phosphor' },
];

const AUTO_APPROVAL_RULES = [
  { label: 'Veteran hash match', desc: 'A single matching hash verification from a Veteran-tier user approves immediately.' },
  { label: 'Trusted hash matches', desc: 'Two matching hash verifications, at least one from a Trusted-tier+ user. A lone Trusted match alone is not enough — it still needs one more confirming vote.' },
  { label: 'Anyone, three matches', desc: 'Three matching hash verifications from anyone, regardless of tier.' },
  { label: 'Manual votes', desc: 'For Verifiers, Administrators, and Veterans who don\u2019t have the file to hash. Two "yes" votes approve — but each "no" raises the bar by one more required "yes".' },
];

const EVENTS = [
  { label: 'Submission approved', delta: '+10', positive: true },
  { label: 'Correct verification', delta: '+2', positive: true },
  { label: 'Correct duplicate report', delta: '+5', positive: true },
  { label: 'Submission rejected', delta: '−10', positive: false },
  { label: 'False verification', delta: '−5', positive: false },
  { label: 'Spam', delta: '−20', positive: false },
];

const STATUSES = [
  { name: 'Pending', desc: 'Just submitted, awaiting verification.' },
  { name: 'Community Verified', desc: 'Weighted verification score crossed the first threshold.' },
  { name: 'Recommended For Approval', desc: 'Score is high enough that an admin can fast-track it.' },
  { name: 'Approved', desc: 'Merged into the master DAT. Terminal state.' },
  { name: 'Rejected', desc: 'Did not meet standards. Terminal state.' },
  { name: 'Disputed', desc: 'Conflicting verifications — needs admin review.' },
];

export default function TrustSystemPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-12">
      <span className="text-phosphor text-xs font-mono uppercase tracking-widest">How it works</span>
      <h1 className="font-display text-3xl font-bold mt-2 mb-6">The trust system</h1>

      <p className="text-text-secondary leading-relaxed mb-10">
        Every account has a trust score that grows or shrinks based on contribution history. Trust determines
        how much weight your verifications carry — a veteran's confirmation counts for ten new accounts.
      </p>

      <h2 className="font-display text-lg font-bold mb-4">Trust tiers</h2>
      <div className="rounded-lg border border-border overflow-hidden mb-10">
        {TIERS.map((t) => (
          <div key={t.name} className="flex items-center justify-between px-4 py-3 border-b border-border-subtle last:border-0">
            <span className={`font-medium ${t.color}`}>{t.name}</span>
            <span className="text-text-muted text-sm font-numeric">{t.range} trust</span>
            <span className="font-mono text-sm text-text-secondary">{t.weight} weight</span>
          </div>
        ))}
      </div>

      <h2 className="font-display text-lg font-bold mb-4">Auto-approval shortcuts</h2>
      <p className="text-text-secondary text-sm leading-relaxed mb-4">
        Separate from the score ladder above, a submission can skip straight to approved without
        admin involvement if one of these is met:
      </p>
      <div className="rounded-lg border border-border overflow-hidden mb-10">
        {AUTO_APPROVAL_RULES.map((r) => (
          <div key={r.label} className="px-4 py-3 border-b border-border-subtle last:border-0">
            <p className="text-sm font-medium text-text-primary">{r.label}</p>
            <p className="text-xs text-text-muted mt-0.5">{r.desc}</p>
          </div>
        ))}
      </div>

      <h2 className="font-display text-lg font-bold mb-4">Trust events</h2>
      <div className="rounded-lg border border-border overflow-hidden mb-10">
        {EVENTS.map((e) => (
          <div key={e.label} className="flex items-center justify-between px-4 py-3 border-b border-border-subtle last:border-0">
            <span className="text-text-secondary text-sm">{e.label}</span>
            <span className={`font-numeric text-sm font-semibold ${e.positive ? 'text-status-approved' : 'text-status-rejected'}`}>
              {e.delta}
            </span>
          </div>
        ))}
      </div>

      <h2 className="font-display text-lg font-bold mb-4">Submission lifecycle</h2>
      <div className="rounded-lg border border-border overflow-hidden">
        {STATUSES.map((s) => (
          <div key={s.name} className="px-4 py-3 border-b border-border-subtle last:border-0">
            <p className="text-sm font-medium text-text-primary">{s.name}</p>
            <p className="text-xs text-text-muted mt-0.5">{s.desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
