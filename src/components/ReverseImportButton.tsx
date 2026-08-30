'use client';

// src/components/ReverseImportButton.tsx
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Undo2 } from 'lucide-react';

export function ReverseImportButton({ importId, entryCount }: { importId: string; entryCount: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);

  const reverse = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/import/${importId}/reverse`, { method: 'POST' });
      if (res.ok) {
        router.refresh();
      }
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
          onClick={reverse}
          className="text-xs px-2 py-1 rounded border border-status-rejected/40 text-status-rejected hover:bg-status-rejected-bg disabled:opacity-50"
        >
          {loading ? 'Reversing…' : `Confirm: reject ${entryCount}`}
        </button>
        <button onClick={() => setConfirming(false)} className="text-xs px-2 py-1 rounded border border-border text-text-muted hover:bg-bg-elevated">
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      title="Reject every entry from this import"
      className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-border text-text-muted hover:border-status-rejected/40 hover:text-status-rejected transition-colors"
    >
      <Undo2 size={11} /> Reverse
    </button>
  );
}
