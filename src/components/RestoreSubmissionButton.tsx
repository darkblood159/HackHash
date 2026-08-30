'use client';

// src/components/RestoreSubmissionButton.tsx
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RotateCcw } from 'lucide-react';

export function RestoreSubmissionButton({ submissionId }: { submissionId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const restore = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/submissions/${submissionId}/restore`, { method: 'POST' });
      if (res.ok) router.refresh();
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={restore}
      disabled={loading}
      className="text-xs px-2.5 py-1.5 rounded-md border border-status-approved/40 text-status-approved hover:bg-status-approved-bg disabled:opacity-50 flex items-center gap-1.5"
    >
      <RotateCcw size={12} /> {loading ? 'Restoring…' : 'Restore'}
    </button>
  );
}
