// src/components/PatchReconcileButton.tsx
'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Wrench, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';

interface ReconcileProblemDetail {
  id: string;
  hackName: string;
  version: string;
  status: string;
  outcome: 'genuinely-missing' | 'inconclusive';
  attemptedPath: string;
  error?: string;
}

interface ReconcileResult {
  checked: number;
  byStatus: Record<string, number>;
  reattached: number;
  genuinelyMissing: number;
  inconclusive: number;
  problems: ReconcileProblemDetail[];
}

export function PatchReconcileButton() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ReconcileResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/admin/patches/reconcile', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Reconcile failed.');
      } else {
        setResult(data);
      }
    } catch (err: any) {
      setError(err?.message || 'Reconcile failed.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <Button variant="secondary" size="sm" loading={loading} onClick={run}>
        <Wrench size={14} className="mr-1.5" /> Reconcile patch files
      </Button>

      {result && (
        <div className="space-y-3">
          <div className="flex items-start gap-2 text-sm text-status-approved">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
            <p className="text-text-secondary">
              Checked <span className="text-text-primary font-medium">{result.checked}</span> submission{result.checked === 1 ? '' : 's'} with a declared patch but no file currently marked as uploaded, across every status (not just approved — see the breakdown below).{' '}
              <span className="text-text-primary font-medium">{result.reattached}</span> {result.reattached === 1 ? 'was' : 'were'} found on disk and reattached.
            </p>
          </div>

          {Object.keys(result.byStatus).length > 0 && (
            <div className="text-xs text-text-secondary flex flex-wrap gap-x-4 gap-y-1 pl-6">
              {Object.entries(result.byStatus).map(([status, count]) => (
                <span key={status}><span className="font-mono text-text-primary">{count}</span> {status.toLowerCase()}</span>
              ))}
            </div>
          )}

          {result.problems.length > 0 && (
            <div className="border border-border rounded-md overflow-hidden">
              <div className="px-3 py-2 bg-bg-elevated text-xs font-medium text-text-secondary uppercase tracking-wide flex items-center gap-1.5">
                <AlertTriangle size={12} /> {result.problems.length} still need attention
              </div>
              <div className="divide-y divide-border max-h-80 overflow-y-auto">
                {result.problems.map((p) => (
                  <div key={p.id} className="px-3 py-2 text-xs space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className={p.outcome === 'inconclusive' ? 'text-status-pending font-medium' : 'text-text-secondary font-medium'}>
                        {p.outcome === 'inconclusive' ? 'Couldn\'t confirm' : 'Genuinely missing'}
                      </span>
                      <span className="text-text-primary">{p.hackName} — {p.version}</span>
                      <span className="text-text-secondary">({p.status.toLowerCase()})</span>
                    </div>
                    <div className="font-mono text-text-secondary break-all">{p.attemptedPath}</div>
                    {p.error && <div className="text-status-rejected">{p.error}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="flex items-center gap-1.5 text-sm text-status-rejected"><XCircle size={14} /> {error}</p>
      )}
    </div>
  );
}
