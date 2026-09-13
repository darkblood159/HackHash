'use client';

// src/components/AlternateFormats.tsx
//
// "Also available as" card on an APPROVED submission's page — lets anyone
// register another compressed/container format of that exact file (e.g.
// the patch produces an .iso, someone separately has an .rvz or .chd copy
// of it) so a person who only has THAT format can verify their copy
// against a known-good hash too, without needing to convert back to the
// original format first. See the AlternateFormat model's own comment in
// prisma/schema.prisma for the full "why", including what this can and
// can't prove on its own — the whole-file hash below matches a copy to
// itself; it doesn't independently prove the compressed file decodes to
// this hack's content, which is exactly why review exists (see canReview
// below, same Verifier/Administrator/Veteran gate the main submission's
// own "manual vote" already uses).
//
// Reuses ROMProcessor.tsx COMPLETELY UNMODIFIED for the hashing step, same
// as BaseRomPicker.tsx/VerifyPanel.tsx already do — an .rvz/.chd file isn't
// a zip/gzip/7z/rar, so classifyArchive() in src/lib/archiveExtract.ts
// already falls through to hashing it directly as a plain file, exactly
// the behavior this feature needs. No changes to that pipeline at all.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ROMProcessor } from './ROMProcessor';
import { Button } from './ui/Button';
import {
  Package, ChevronDown, CheckCircle2, Clock, XCircle, AlertTriangle, Trash2, Plus, UploadCloud,
} from 'lucide-react';
import { clsx } from 'clsx';
import { formatDistanceToNow } from 'date-fns';
import { TRUST_TIER_THRESHOLDS } from '@/types';
import { COMMON_ALTERNATE_FORMATS, guessFormatLabel } from '@/lib/alternateFormats';
import type { ROMFileInfo } from '@/types';

const VETERAN_THRESHOLD = TRUST_TIER_THRESHOLDS.VETERAN;

export interface AlternateFormatItem {
  id: string;
  format: string;
  filename: string;
  fileSize: string; // BigInt already stringified server-side
  crc32: string;
  md5: string;
  sha1: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  verifiedByHash: boolean;
  rejectionReason: string | null;
  createdAt: string;
  addedBy: { id: string; name: string | null; username: string | null } | null;
  reviewedBy: { id: string; name: string | null; username: string | null } | null;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function displayName(u: { name: string | null; username: string | null } | null): string {
  if (!u) return 'someone';
  return u.name ?? u.username ?? 'someone';
}

function StatusPill({ status, verifiedByHash }: { status: AlternateFormatItem['status']; verifiedByHash: boolean }) {
  if (status === 'APPROVED') {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-status-approved"
        title={verifiedByHash ? 'Verified automatically — a qualified reviewer dropped a file that matched exactly' : 'Verified by a reviewer'}
      >
        <CheckCircle2 size={12} /> {verifiedByHash ? 'Verified · hash match' : 'Verified'}
      </span>
    );
  }
  if (status === 'PENDING') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-status-pending">
        <Clock size={12} /> Unverified
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-status-rejected">
      <XCircle size={12} /> Rejected
    </span>
  );
}

function FormatRow({
  submissionId, item, canReview, viewerId, isAdmin,
}: {
  submissionId: string;
  item: AlternateFormatItem;
  canReview: boolean;
  viewerId: string | null;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<ROMFileInfo | null>(null);

  const isOwn = viewerId !== null && item.addedBy?.id === viewerId;
  const canRemove = isAdmin || (isOwn && item.status === 'PENDING');
  const checkMatches = checkResult ? checkResult.sha1.toLowerCase() === item.sha1.toLowerCase() : null;

  const review = async (approve: boolean, verifiedHash?: { crc32: string; md5: string; sha1: string }) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/submissions/${submissionId}/formats/${item.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approve,
          rejectionReason: approve ? undefined : (reason || undefined),
          verifiedHash,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'Failed to update');
        return;
      }
      router.refresh();
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  };

  // Fires the moment a qualified reviewer's own dropped file proves an
  // exact match — mirrors checkAutoApproval's hasVeteranMatch rule for the
  // PRIMARY submission (a single Veteran-tier-or-above hash match is
  // already enough there, no separate vote needed): same trust bar
  // (canReview), same "one real match from someone qualified is enough"
  // principle, no extra click required. The server independently re-checks
  // the claimed hash against what's actually stored before honoring this
  // (see the review route) — this call is a REQUEST, not a guarantee.
  // Skipped when already APPROVED (nothing to change) or when the viewer
  // doesn't qualify to review at all (isOwn-without-admin, or not a
  // reviewer) — for everyone else this stays exactly what it already was:
  // an informational match/mismatch result with no side effect.
  const handleCheckFile = (info: ROMFileInfo) => {
    setCheckResult(info);
    setChecking(false);
    const matches = info.sha1.toLowerCase() === item.sha1.toLowerCase();
    if (matches && canReview && (!isOwn || isAdmin) && item.status !== 'APPROVED') {
      review(true, { crc32: info.crc32, md5: info.md5, sha1: info.sha1 });
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/submissions/${submissionId}/formats/${item.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'Failed to remove');
        return;
      }
      router.refresh();
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
      setConfirmingRemove(false);
    }
  };

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-base overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-bg-elevated transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-phosphor/10 text-phosphor shrink-0">
            {item.format}
          </span>
          <span className="text-sm text-text-primary truncate">{item.filename}</span>
          <span className="text-xs text-text-muted shrink-0 hidden sm:inline">{formatBytes(Number(item.fileSize))}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StatusPill status={item.status} verifiedByHash={item.verifiedByHash} />
          <ChevronDown size={14} className={clsx('text-text-muted transition-transform', expanded && 'rotate-180')} />
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border-subtle space-y-3">
          <div className="space-y-0 font-mono text-xs">
            <div className="flex items-center justify-between py-1 gap-3"><span className="text-text-muted uppercase tracking-wider shrink-0">CRC32</span><span className="text-phosphor truncate">{item.crc32}</span></div>
            <div className="flex items-center justify-between py-1 gap-3"><span className="text-text-muted uppercase tracking-wider shrink-0">MD5</span><span className="text-phosphor truncate">{item.md5}</span></div>
            <div className="flex items-center justify-between py-1 gap-3"><span className="text-text-muted uppercase tracking-wider shrink-0">SHA1</span><span className="text-phosphor truncate">{item.sha1}</span></div>
          </div>

          <p className="text-[11px] text-text-muted">
            Added by {displayName(item.addedBy)} {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
            {item.reviewedBy && (
              <>
                {' · '}
                {item.status === 'REJECTED'
                  ? 'rejected'
                  : item.verifiedByHash
                    ? 'auto-verified by an exact hash match from'
                    : 'verified by'}
                {' '}{displayName(item.reviewedBy)}
              </>
            )}
          </p>

          {item.status === 'REJECTED' && item.rejectionReason && (
            <p className="text-[11px] text-status-rejected">Reason: {item.rejectionReason}</p>
          )}

          {error && <p className="text-[11px] text-status-rejected">{error}</p>}

          {/* Drop-to-check — open to anyone, signed in or not, same as VerifyPanel's
              own hash-check on the main submission: this is a read-only, entirely
              client-side comparison (nothing is uploaded, nothing is written), so
              there's no reason to gate merely CHECKING behind canReview. For a
              qualified reviewer (not reviewing their own entry, or an admin), a
              match doesn't just inform — it AUTO-VERIFIES immediately, no separate
              click (see handleCheckFile above and the review route's own
              `verifiedHash` handling) — mirrors the primary submission's own
              "a single Veteran+ hash match is enough" rule. Everyone else just
              gets the informational result, same as before. */}
          <div className="pt-1 border-t border-border-subtle">
            {!checking && !checkResult && (
              <button
                type="button"
                onClick={() => setChecking(true)}
                className="inline-flex items-center gap-1.5 text-[11px] text-phosphor hover:underline"
              >
                <UploadCloud size={12} />
                {canReview && (!isOwn || isAdmin) && item.status !== 'APPROVED'
                  ? 'Have a copy? Drop it to verify'
                  : 'Have a copy? Drop it to check against this hash'}
              </button>
            )}

            {checking && !checkResult && (
              <div className="space-y-2">
                <ROMProcessor
                  onFileProcessed={handleCheckFile}
                  showUseButton={false}
                  label={`Drop your ${item.format} file here`}
                  hint="Hashed locally in your browser — never uploaded"
                />
                <button type="button" onClick={() => setChecking(false)} className="text-[11px] text-text-muted hover:text-text-primary underline">
                  Cancel
                </button>
              </div>
            )}

            {checkResult && (
              <div className={clsx(
                'p-2.5 rounded-md border text-xs space-y-1.5',
                checkMatches ? 'border-status-approved/30 bg-status-approved-bg' : 'border-status-rejected/30 bg-status-rejected-bg',
              )}>
                <p className={clsx('flex items-center gap-1.5 font-medium', checkMatches ? 'text-status-approved' : 'text-status-rejected')}>
                  {checkMatches ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                  {checkMatches
                    ? 'This file matches this entry\u2019s hash exactly'
                    : 'This file does not match this entry\u2019s hash'}
                </p>
                <p className="font-mono text-[10px] text-text-muted truncate">{checkResult.filename} · SHA1 {checkResult.sha1}</p>
                {checkMatches && canReview && (!isOwn || isAdmin) && item.status !== 'APPROVED' && (
                  <p className="text-[11px] text-status-approved">
                    {busy ? 'Verifying automatically…' : 'Verified automatically — an exact match from a qualified reviewer is enough on its own.'}
                  </p>
                )}
                {!checkMatches && (
                  <p className="text-[11px] text-text-secondary">
                    Worth checking you dropped the right file before treating this as evidence against the entry — a mismatch could mean either one is wrong.
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => { setCheckResult(null); setChecking(false); }}
                  className="text-[11px] text-text-muted hover:text-text-primary underline"
                >
                  Check another file
                </button>
              </div>
            )}
          </div>

          {canReview && (!isOwn || isAdmin) && (
            <div className="space-y-2 pt-1 border-t border-border-subtle">
              {checkResult && !checkMatches && (
                <p className="text-[11px] text-status-rejected">
                  The file you just checked doesn&rsquo;t back up confirming this one.
                </p>
              )}
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason if rejecting (optional)"
                className="w-full px-2.5 py-1.5 rounded-md bg-bg-surface border border-border text-xs placeholder:text-text-muted"
              />
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" loading={busy} onClick={() => review(true)}>
                  {item.status === 'APPROVED' ? 'Confirmed match' : 'Confirm match'}
                </Button>
                <Button size="sm" variant="danger" loading={busy} onClick={() => review(false)}>
                  {item.status === 'REJECTED' ? 'Rejected' : 'Reject'}
                </Button>
              </div>
            </div>
          )}

          {canRemove && (
            <div className="pt-1 border-t border-border-subtle">
              {!confirmingRemove ? (
                <button
                  type="button"
                  onClick={() => setConfirmingRemove(true)}
                  className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-status-rejected"
                >
                  <Trash2 size={11} /> Remove
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-text-secondary">Remove this entry? This can't be undone.</span>
                  <button type="button" disabled={busy} onClick={remove} className="text-[11px] text-status-rejected underline">
                    Yes, remove
                  </button>
                  <button type="button" disabled={busy} onClick={() => setConfirmingRemove(false)} className="text-[11px] text-text-muted underline">
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AlternateFormats({
  submissionId,
  formats,
  canAdd,
  viewerId,
  viewerRole,
  viewerTrustScore,
}: {
  submissionId: string;
  formats: AlternateFormatItem[];
  canAdd: boolean;
  viewerId: string | null;
  viewerRole: string;
  viewerTrustScore: number;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [formatLabel, setFormatLabel] = useState('');
  const [hashResult, setHashResult] = useState<ROMFileInfo | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canReview = viewerRole === 'VERIFIER' || viewerRole === 'ADMINISTRATOR' || viewerTrustScore >= VETERAN_THRESHOLD;
  const isAdmin = viewerRole === 'ADMINISTRATOR';

  const handleHashed = (info: ROMFileInfo) => {
    setHashResult(info);
    if (!formatLabel.trim()) {
      const guess = guessFormatLabel(info.filename);
      if (guess) setFormatLabel(guess);
    }
  };

  const resetAddForm = () => {
    setAdding(false);
    setFormatLabel('');
    setHashResult(null);
    setError(null);
  };

  const submit = async () => {
    if (!hashResult || !formatLabel.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/submissions/${submissionId}/formats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format: formatLabel.trim(),
          filename: hashResult.filename,
          fileSize: hashResult.fileSize,
          crc32: hashResult.crc32,
          md5: hashResult.md5,
          sha1: hashResult.sha1,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'Failed to add format');
        return;
      }
      resetAddForm();
      router.refresh();
    } catch {
      setError('Network error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-5 rounded-lg border border-border bg-bg-surface">
      <div className="flex items-center gap-2 mb-1">
        <Package size={16} className="text-phosphor" />
        <h2 className="text-sm font-semibold text-text-primary">Also available as</h2>
      </div>
      <p className="text-xs text-text-muted mb-4">
        Other compressed or container copies of this exact file — say the patch produces an .iso and you've
        separately got it as .rvz or .chd. A qualified reviewer who drops a matching copy verifies it
        automatically; anyone else can still drop one just to check their own copy.
      </p>

      {formats.length === 0 && !adding && (
        <p className="text-xs text-text-muted italic">No alternate formats registered yet.</p>
      )}

      {formats.length > 0 && (
        <div className="space-y-2 mb-3">
          {formats.map((f) => (
            <FormatRow key={f.id} submissionId={submissionId} item={f} canReview={canReview} viewerId={viewerId} isAdmin={isAdmin} />
          ))}
        </div>
      )}

      {canAdd && !adding && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1.5 text-xs text-phosphor hover:underline"
        >
          <Plus size={13} /> Add a format
        </button>
      )}

      {canAdd && adding && (
        <div className="mt-2 p-3 rounded-lg border border-border bg-bg-base space-y-3">
          <div className="flex items-start gap-2 p-2.5 rounded-md bg-status-pending-bg border border-status-pending/30">
            <AlertTriangle size={13} className="text-status-pending shrink-0 mt-0.5" />
            <p className="text-xs text-status-pending">
              Only add a format made directly from this exact submission's file — the one hashed above on this page.
              Not a different version, a hand edit, or a separate rip. If it doesn't actually match, it'll get
              rejected on review.
            </p>
          </div>

          <div>
            <label className="text-xs text-text-muted block mb-1">Format label</label>
            <input
              value={formatLabel}
              onChange={(e) => setFormatLabel(e.target.value)}
              placeholder="e.g. RVZ, CHD, WBFS…"
              list="alt-format-suggestions"
              maxLength={50}
              className="w-full px-3 py-2 rounded-md bg-bg-surface border border-border text-text-primary text-sm placeholder:text-text-muted focus:border-phosphor/50"
            />
            <datalist id="alt-format-suggestions">
              {COMMON_ALTERNATE_FORMATS.map((f) => <option key={f} value={f} />)}
            </datalist>
          </div>

          {!hashResult ? (
            <ROMProcessor
              onFileProcessed={handleHashed}
              showUseButton={false}
              label="Select or drop the alternate-format file"
              hint="Hashed locally in your browser — never uploaded, same as everywhere else on this site"
            />
          ) : (
            <div className="p-2.5 rounded-md border border-phosphor/20 bg-phosphor/5 text-xs text-text-secondary flex items-center justify-between gap-2">
              <span className="truncate">{hashResult.filename} · {formatBytes(hashResult.fileSize)}</span>
              <button type="button" onClick={() => setHashResult(null)} className="text-text-muted hover:text-text-primary underline shrink-0">
                Re-hash
              </button>
            </div>
          )}

          {error && <p className="text-xs text-status-rejected">{error}</p>}

          <div className="flex gap-2">
            <Button size="sm" disabled={!hashResult || !formatLabel.trim()} loading={submitting} onClick={submit}>
              Add format
            </Button>
            <Button size="sm" variant="ghost" onClick={resetAddForm}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
