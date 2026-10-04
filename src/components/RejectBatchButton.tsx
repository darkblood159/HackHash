'use client';

// src/components/RejectBatchButton.tsx
//
// Same two-step confirm shape as ReverseImportButton, for withdrawing a
// whole bulk-submit batch (POST /api/admin/submission-batches/[id]/reject).
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Undo2 } from 'lucide-react';

export function RejectBatchButton({ batchId, pendingCount }: { batchId: string; pendingCount: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reject = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/submission-batches/${batchId}/reject`, { method: 'POST' });
      if (res.ok) {
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'Failed');
      }
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
      setConfirming(false);
    }
  };

  if (confirming) {
    return (
      <div className="flex items-center gap-1.5">
        <button
          disabled={loading}
          onClick={reject}
          className="text-xs px-2 py-1 rounded border border-status-rejected/40 text-status-rejected hover:bg-status-rejected-bg disabled:opacity-50"
        >
          {loading ? 'Rejecting…' : `Confirm: reject ${pendingCount} pending`}
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="text-xs px-2 py-1 rounded border border-border text-text-muted hover:bg-bg-elevated"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-status-rejected">{error}</span>}
      <button
        onClick={() => setConfirming(true)}
        title="Reject every still-pending entry in this batch. Already-decided entries are left alone."
        className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-border text-text-muted hover:border-status-rejected/40 hover:text-status-rejected transition-colors"
      >
        <Undo2 size={11} /> Reject pending
      </button>
    </div>
  );
}
