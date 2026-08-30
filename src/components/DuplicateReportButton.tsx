'use client';

// src/components/DuplicateReportButton.tsx
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from './ui/Button';
import { Copy } from 'lucide-react';

const TYPES = [
  { value: 'SAME_ROM_DIFFERENT_FILENAME', label: 'Same ROM, different filename' },
  { value: 'SAME_ROM_DIFFERENT_VERSION', label: 'Same ROM, different version' },
  { value: 'DIFFERENT_ROM', label: 'Different ROM entirely' },
];

export function DuplicateReportButton({ submissionId }: { submissionId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState(TYPES[0].value);
  const [duplicateOfId, setDuplicateOfId] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/submissions/${submissionId}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          duplicateType: type,
          duplicateOfId: duplicateOfId || undefined,
          notes: notes || undefined,
        }),
      });
      if (res.ok) {
        setDone(true);
        router.refresh();
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="p-4 rounded-lg border border-border bg-bg-elevated text-xs text-text-muted">
        Duplicate report submitted. Thanks for keeping the database clean.
      </div>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-border text-text-secondary text-sm hover:border-status-disputed/40 hover:text-status-disputed transition-colors"
      >
        <Copy size={14} /> Report as duplicate
      </button>
    );
  }

  return (
    <div className="p-5 rounded-lg border border-border bg-bg-surface space-y-3">
      <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider">Report duplicate</h2>
      <select value={type} onChange={(e) => setType(e.target.value)} className="w-full px-3 py-2 rounded-md bg-bg-base border border-border text-sm">
        {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
      </select>
      <input
        placeholder="Original submission ID (optional)"
        value={duplicateOfId}
        onChange={(e) => setDuplicateOfId(e.target.value)}
        className="w-full px-3 py-2 rounded-md bg-bg-base border border-border text-sm font-mono"
      />
      <textarea
        placeholder="Notes"
        rows={2}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        className="w-full px-3 py-2 rounded-md bg-bg-base border border-border text-sm"
      />
      <div className="flex gap-2">
        <Button size="sm" loading={submitting} onClick={submit}>Submit report</Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </div>
  );
}
