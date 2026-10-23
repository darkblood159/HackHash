'use client';

// src/components/IssueReportButton.tsx
//
// "Report an issue" on an entry page (replaced DuplicateReportButton). The
// person picks the kind of problem from a short list, may leave a comment, and
// an admin sees it in /admin/reports. The list, wording and validation come
// from src/lib/issueReports.ts so the form and the API can't drift apart.
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Flag } from 'lucide-react';
import { Button } from './ui/Button';
import { ISSUE_TYPES, ISSUE_COMMENT_MAX, type IssueTypeValue } from '@/lib/issueReports';

export function IssueReportButton({ submissionId }: { submissionId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<IssueTypeValue | null>(null);
  const [duplicateOf, setDuplicateOf] = useState('');
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const selected = ISSUE_TYPES.find((t) => t.value === type) ?? null;
  const needsComment = !!selected?.commentRequired;
  const canSubmit = !!selected && (!needsComment || comment.trim().length > 0);

  const submit = async () => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/submissions/${submissionId}/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: selected.value,
          comment: comment.trim() || undefined,
          duplicateOfId: selected.value === 'DUPLICATE' ? duplicateOf.trim() || undefined : undefined,
        }),
      });
      if (res.ok) {
        setDone(true);
        router.refresh();
        return;
      }
      const data = await res.json().catch(() => null);
      setError(
        res.status === 429
          ? 'You’re reporting a lot of issues — please wait a few minutes and try again.'
          : data?.error ?? 'Something went wrong. Please try again.'
      );
    } catch {
      setError('Couldn’t reach the server. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="p-4 rounded-lg border border-border bg-bg-elevated text-xs text-text-muted">
        Thanks — your report was sent and an admin will take a look.
      </div>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-border text-text-secondary text-sm hover:border-status-disputed/40 hover:text-status-disputed transition-colors"
      >
        <Flag size={14} /> Report an issue
      </button>
    );
  }

  return (
    <div className="p-5 rounded-lg border border-border bg-bg-surface space-y-3">
      <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider">Report an issue</h2>

      <fieldset className="space-y-1.5">
        <legend className="sr-only">What’s wrong?</legend>
        {ISSUE_TYPES.map((t) => (
          <label
            key={t.value}
            className={
              'flex items-start gap-3 px-3 py-2.5 rounded-md border cursor-pointer transition-colors ' +
              (type === t.value ? 'border-phosphor/50 bg-phosphor/5' : 'border-border hover:border-phosphor/30')
            }
          >
            <input
              type="radio"
              name={`issue-type-${submissionId}`}
              value={t.value}
              checked={type === t.value}
              onChange={() => setType(t.value)}
              className="mt-1 accent-phosphor"
            />
            <span className="min-w-0">
              <span className="block text-sm text-text-primary">{t.label}</span>
              <span className="block text-xs text-text-muted">{t.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {type === 'DUPLICATE' && (
        <input
          placeholder="Link to the original entry (optional)"
          value={duplicateOf}
          onChange={(e) => setDuplicateOf(e.target.value)}
          className="w-full px-3 py-2 rounded-md bg-bg-base border border-border text-sm"
        />
      )}

      <textarea
        aria-label={needsComment ? 'Tell us what’s wrong' : 'Leave a comment (optional)'}
        placeholder={needsComment ? 'Tell us what’s wrong (required)' : 'Leave a comment (optional)'}
        rows={3}
        maxLength={ISSUE_COMMENT_MAX}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        className="w-full px-3 py-2 rounded-md bg-bg-base border border-border text-sm"
      />

      {error && (
        <p role="alert" className="text-xs text-status-rejected">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button size="sm" loading={submitting} disabled={!canSubmit} onClick={submit}>
          Send report
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
