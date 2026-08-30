'use client';

// src/components/VerifyPanel.tsx
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ROMProcessor } from './ROMProcessor';
import { Button } from './ui/Button';
import { CheckCircle2, XCircle, ShieldCheck, MessageSquareText, Sparkles } from 'lucide-react';
import { clsx } from 'clsx';
import type { ROMFileInfo } from '@/types';
import { TRUST_TIER_THRESHOLDS } from '@/types';

const VETERAN_THRESHOLD = TRUST_TIER_THRESHOLDS.VETERAN;

interface VerifyPanelProps {
  submissionId: string;
  expectedHashes: { crc32: string; md5: string; sha1: string };
  viewerTrustScore: number;
  viewerRole: string;
}

export function VerifyPanel({ submissionId, expectedHashes, viewerTrustScore, viewerRole }: VerifyPanelProps) {
  const router = useRouter();
  const [mode, setMode] = useState<'hash' | 'manual'>('hash');
  const [result, setResult] = useState<ROMFileInfo | null>(null);
  const [manualVote, setManualVote] = useState<boolean | null>(null);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [autoApproved, setAutoApproved] = useState<{ name: string } | null>(null);

  const canManualVote = viewerRole === 'VERIFIER' || viewerRole === 'ADMINISTRATOR' || viewerTrustScore >= VETERAN_THRESHOLD;

  const comparison = result
    ? {
        crc32: result.crc32 === expectedHashes.crc32,
        md5: result.md5 === expectedHashes.md5,
        sha1: result.sha1 === expectedHashes.sha1,
      }
    : null;

  const allMatch = comparison ? comparison.crc32 && comparison.md5 && comparison.sha1 : false;

  const submit = async (body: Record<string, unknown>) => {
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/submissions/${submissionId}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'Verification failed');
        return;
      }

      const data = await res.json();
      if (data.autoApproved) {
        setAutoApproved({ name: data.autoApproved.name });
      }
      setDone(true);
      router.refresh();
    } catch {
      setError('Network error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleHashVerify = (matches: boolean) =>
    submit({
      matches,
      sha1Matched: comparison?.sha1,
      md5Matched: comparison?.md5,
      crc32Matched: comparison?.crc32,
      notes: notes || undefined,
    });

  const handleManualVote = () => {
    if (manualVote === null) return;
    submit({ matches: manualVote, isManualVote: true, notes: notes || undefined });
  };

  if (done) {
    return (
      <div className={clsx(
        'p-5 rounded-lg border flex items-start gap-3',
        autoApproved ? 'border-phosphor/40 bg-phosphor/10' : 'border-phosphor/30 bg-phosphor/5'
      )}>
        {autoApproved ? <Sparkles size={20} className="text-phosphor shrink-0" /> : <CheckCircle2 size={20} className="text-phosphor shrink-0" />}
        <div>
          <p className="text-sm text-text-primary font-medium">
            {autoApproved ? 'Auto-approved!' : 'Thanks — your verification has been recorded.'}
          </p>
          {autoApproved && (
            <p className="text-xs text-text-secondary mt-1">
              This vote crossed an auto-approval threshold, so "{autoApproved.name}" just went straight into the DAT.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="p-5 rounded-lg border border-border bg-bg-surface">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} className="text-phosphor" />
          <h2 className="text-sm font-semibold text-text-primary">Verify this submission</h2>
        </div>
        {canManualVote && (
          <div className="flex rounded-md border border-border overflow-hidden text-xs">
            <button
              onClick={() => setMode('hash')}
              className={clsx('px-2.5 py-1', mode === 'hash' ? 'bg-phosphor/15 text-phosphor' : 'text-text-muted hover:bg-bg-elevated')}
            >
              Hash check
            </button>
            <button
              onClick={() => setMode('manual')}
              className={clsx('px-2.5 py-1', mode === 'manual' ? 'bg-phosphor/15 text-phosphor' : 'text-text-muted hover:bg-bg-elevated')}
            >
              Manual vote
            </button>
          </div>
        )}
      </div>

      {mode === 'hash' && (
        <>
          <p className="text-xs text-text-muted mb-4">
            Hash your own copy of this ROM. We'll compare it locally — only the match result is sent.
          </p>

          {!result && <ROMProcessor onFileProcessed={setResult} showUseButton={false} />}

          {result && comparison && (
            <div className="space-y-4">
              <div className="rounded-lg border border-border overflow-hidden">
                {(['crc32', 'md5', 'sha1'] as const).map((key) => (
                  <div key={key} className={clsx('flex items-center justify-between px-3 py-2 text-xs font-mono border-b border-border-subtle last:border-0', comparison[key] ? 'bg-status-approved-bg' : 'bg-status-rejected-bg')}>
                    <span className="uppercase text-text-muted tracking-wider">{key}</span>
                    <div className="flex items-center gap-2">
                      {comparison[key] ? <CheckCircle2 size={13} className="text-status-approved" /> : <XCircle size={13} className="text-status-rejected" />}
                      <span className={comparison[key] ? 'text-status-approved' : 'text-status-rejected'}>
                        {comparison[key] ? 'Match' : 'Mismatch'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              <textarea
                placeholder="Optional notes for other reviewers"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full px-3 py-2 rounded-md bg-bg-base border border-border text-sm placeholder:text-text-muted"
              />

              {error && <p className="text-xs text-status-rejected">{error}</p>}

              <div className="flex gap-3">
                <Button onClick={() => handleHashVerify(allMatch)} loading={submitting} variant={allMatch ? 'primary' : 'danger'}>
                  {allMatch ? 'Confirm — hashes match' : 'Submit — hashes do not match'}
                </Button>
                <Button variant="ghost" onClick={() => setResult(null)}>Re-hash</Button>
              </div>
            </div>
          )}
        </>
      )}

      {mode === 'manual' && (
        <div className="space-y-4">
          <div className="flex items-start gap-2 p-2.5 rounded-md bg-status-pending-bg border border-status-pending/30">
            <MessageSquareText size={13} className="text-status-pending shrink-0 mt-0.5" />
            <p className="text-xs text-status-pending">
              For when you don't have the file to hash, but can vouch for this submission based on review.
              Two "yes" votes approve it — but if anyone votes "no" first, it takes three "yes" votes instead.
            </p>
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => setManualVote(true)}
              className={clsx('flex-1 py-2.5 rounded-md border text-sm font-medium transition-colors',
                manualVote === true ? 'border-status-approved bg-status-approved-bg text-status-approved' : 'border-border text-text-secondary hover:border-status-approved/40')}
            >
              Yes, looks legitimate
            </button>
            <button
              onClick={() => setManualVote(false)}
              className={clsx('flex-1 py-2.5 rounded-md border text-sm font-medium transition-colors',
                manualVote === false ? 'border-status-rejected bg-status-rejected-bg text-status-rejected' : 'border-border text-text-secondary hover:border-status-rejected/40')}
            >
              No, something's off
            </button>
          </div>

          <textarea
            placeholder="Why? (visible to other reviewers and admins)"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full px-3 py-2 rounded-md bg-bg-base border border-border text-sm placeholder:text-text-muted"
          />

          {error && <p className="text-xs text-status-rejected">{error}</p>}

          <Button onClick={handleManualVote} loading={submitting} disabled={manualVote === null}>
            Submit manual vote
          </Button>
        </div>
      )}
    </div>
  );
}
