'use client';

// src/components/ForceRepullButton.tsx
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, Download } from 'lucide-react';

// AUG-28: added a second, non-destructive option alongside the original
// Force re-check. The original always pulls with overwrite:true — Hasheous's
// current answer replaces whatever's stored, INCLUDING clearing a field to
// empty if Hasheous doesn't currently have a match for that specific source.
// That's fine when Hasheous has a genuinely more current answer, but it has
// a real, non-obvious edge: Hasheous backfills a "no match yet" row for
// every source on every object it knows about (confirmed in hasheous.ts's
// extractMappings), so "no match" and "nobody's looked this source up yet"
// are indistinguishable in what it returns — an overwrite pull can't tell
// them apart, so it clears both the same way. If a hash only just got a
// PARTIAL match on Hasheous's side (one source matched, others not attempted
// yet), an overwrite pull will happily wipe out any other sources this
// project already had mapped locally, even ones Hasheous simply hasn't
// gotten to yet. This second button is for exactly that situation: pull
// whatever's new without touching or clearing anything already stored here.
type PullMode = 'overwrite' | 'fill';

export function ForceRepullButton({ submissionId }: { submissionId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState<PullMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pull = async (mode: PullMode) => {
    setLoading(mode);
    setError(null);
    try {
      const res = await fetch('/api/admin/hasheous/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // onlyMissing/skipSynced both false either way: process this
        // submission regardless of its current sync status. overwrite is
        // the one thing that differs between the two buttons below.
        body: JSON.stringify({
          submissionIds: [submissionId],
          onlyMissing: false,
          skipSynced: false,
          overwrite: mode === 'overwrite',
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'Re-check failed');
        return;
      }
      // Single-submission pull is fast but still runs as a background job —
      // give it a moment before refreshing the page's data.
      await new Promise((r) => setTimeout(r, 3000));
      router.refresh();
    } catch {
      setError('Network error — please try again');
    } finally {
      setLoading(null);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => pull('fill')}
          disabled={loading !== null}
          title="Add anything new from Hasheous. Never touches or clears a field that's already set here."
          className="text-xs px-2.5 py-1.5 rounded-md border border-border text-text-secondary hover:border-phosphor/40 hover:text-phosphor disabled:opacity-50 flex items-center gap-1.5 transition-colors"
        >
          <Download size={12} className={loading === 'fill' ? 'animate-spin' : ''} />
          {loading === 'fill' ? 'Pulling…' : 'Pull new fields only'}
        </button>
        <button
          onClick={() => pull('overwrite')}
          disabled={loading !== null}
          title="Replace everything with Hasheous's current answer, including clearing fields Hasheous doesn't currently have a match for."
          className="text-xs px-2.5 py-1.5 rounded-md border border-status-rejected/30 text-status-rejected/80 hover:border-status-rejected/60 hover:text-status-rejected disabled:opacity-50 flex items-center gap-1.5 transition-colors"
        >
          <RefreshCw size={12} className={loading === 'overwrite' ? 'animate-spin' : ''} />
          {loading === 'overwrite' ? 'Re-checking…' : 'Force re-check (overwrite)'}
        </button>
      </div>
      {error && <p className="text-xs text-status-rejected mt-1">{error}</p>}
    </div>
  );
}
