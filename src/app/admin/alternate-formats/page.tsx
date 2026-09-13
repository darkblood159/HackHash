'use client';

// src/app/admin/alternate-formats/page.tsx
//
// The review queue that was missing entirely before — an alt-format entry
// used to only become visible by opening the exact submission it was added
// to. Mirrors /admin/base-roms's tabbed Pending/Approved/Rejected shape
// closely (same PENDING-count-always-returned API pattern, same tab bar).
// Approve/Reject/Remove here call the SAME routes the submission page's own
// "Also available as" card uses (src/app/api/submissions/[id]/formats/...)
// — this page is just a second, admin-centric front door onto the exact
// same review action, not a parallel implementation of it.
//
// "Match a file" section (added later, same feature): lets a reviewer who
// has a batch of files to get through drop one WITHOUT already knowing
// which submission it belongs to — it gets hashed locally, then checked
// against every entry across all three statuses (not just whichever tab
// happens to be open), and if found, shown with the exact same review
// actions as the main list. Reuses ROMProcessor.tsx unmodified for the
// hashing step, same as everywhere else this pattern appears in this app.
import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { Package, CheckCircle2, XCircle, Trash2, UploadCloud, SearchX } from 'lucide-react';
import { ROMProcessor } from '@/components/ROMProcessor';
import type { ROMFileInfo } from '@/types';

interface FormatRow {
  id: string;
  submissionId: string;
  format: string;
  filename: string;
  fileSize: string;
  crc32: string;
  md5: string;
  sha1: string;
  status: string;
  verifiedByHash: boolean;
  rejectionReason: string | null;
  createdAt: string;
  addedBy: { id: string; name: string | null; username: string | null } | null;
  reviewedBy: { id: string; name: string | null; username: string | null } | null;
  submission: { hackName: string; version: string; platform: string };
}

const TABS = [
  { key: 'PENDING', label: 'Pending review' },
  { key: 'APPROVED', label: 'Verified' },
  { key: 'REJECTED', label: 'Rejected' },
] as const;

function displayName(u: { name: string | null; username: string | null } | null): string {
  if (!u) return 'someone';
  return u.name ?? u.username ?? 'someone';
}

// Pulled out of the tab list so the "match a file" result (which can be any
// status, not whichever tab happens to be open) can render with the exact
// same card and reuse the exact same review/remove actions — one place for
// this markup rather than two copies that could quietly drift apart.
function RowCard({
  row, busyId, rejectingId, rejectReason, removingId,
  onSetRejectReason, onReview, onRemove, onToggleReject, onToggleRemove,
}: {
  row: FormatRow;
  busyId: string | null;
  rejectingId: string | null;
  rejectReason: string;
  removingId: string | null;
  onSetRejectReason: (v: string) => void;
  onReview: (row: FormatRow, approve: boolean) => void;
  onRemove: (row: FormatRow) => void;
  onToggleReject: (id: string | null) => void;
  onToggleRemove: (id: string | null) => void;
}) {
  return (
    <div className="p-4 rounded-lg border border-border bg-bg-surface">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3">
          <Package size={18} className="text-phosphor shrink-0 mt-0.5" />
          <div>
            <p className="text-text-primary font-medium">
              <Link href={`/submissions/${row.submissionId}`} className="hover:text-phosphor hover:underline">
                {row.submission.hackName} (v{row.submission.version})
              </Link>
              <span className="ml-2 text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-phosphor/10 text-phosphor align-middle">
                {row.format}
              </span>
            </p>
            <p className="text-xs text-text-muted mt-0.5">
              {row.filename} · added by {displayName(row.addedBy)} · {new Date(row.createdAt).toLocaleDateString()}
              {row.reviewedBy && (
                <>
                  {' · '}
                  {row.status === 'REJECTED'
                    ? 'rejected'
                    : row.verifiedByHash ? 'auto-verified (hash match) by' : 'verified by'}
                  {' '}{displayName(row.reviewedBy)}
                </>
              )}
            </p>
            <p className="text-xs font-mono text-text-muted mt-1">
              CRC32 {row.crc32} · MD5 {row.md5}
            </p>
            <p className="text-xs font-mono text-text-muted">SHA-1 {row.sha1}</p>
            {row.status === 'REJECTED' && row.rejectionReason && (
              <p className="text-xs text-status-rejected mt-1">Rejected: {row.rejectionReason}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            disabled={busyId === row.id}
            onClick={() => { onToggleRemove(removingId === row.id ? null : row.id); onToggleReject(null); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-text-muted text-xs font-medium hover:border-status-rejected/40 hover:text-status-rejected transition-colors disabled:opacity-50"
          >
            <Trash2 size={13} /> Remove
          </button>
          <button
            disabled={busyId === row.id}
            onClick={() => onReview(row, true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-phosphor/15 border border-phosphor/40 text-phosphor text-xs font-medium hover:bg-phosphor/25 transition-colors disabled:opacity-50"
          >
            <CheckCircle2 size={13} /> {row.status === 'APPROVED' ? 'Verified' : 'Confirm match'}
          </button>
          <button
            disabled={busyId === row.id}
            onClick={() => { onToggleReject(rejectingId === row.id ? null : row.id); onToggleRemove(null); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-text-muted text-xs font-medium hover:border-status-rejected/40 hover:text-status-rejected transition-colors disabled:opacity-50"
          >
            <XCircle size={13} /> {row.status === 'REJECTED' ? 'Rejected' : 'Reject'}
          </button>
        </div>
      </div>

      {rejectingId === row.id && (
        <div className="mt-3 flex gap-2">
          <input
            value={rejectReason}
            onChange={(e) => onSetRejectReason(e.target.value)}
            placeholder="Reason (optional)"
            className="flex-1 px-3 py-1.5 rounded-md bg-bg-base border border-border text-text-primary text-xs placeholder:text-text-muted focus:border-phosphor/50"
          />
          <button
            disabled={busyId === row.id}
            onClick={() => onReview(row, false)}
            className="px-3 py-1.5 rounded-md bg-status-rejected/20 text-status-rejected text-xs font-medium hover:bg-status-rejected/30 transition-colors disabled:opacity-50"
          >
            Confirm reject
          </button>
        </div>
      )}

      {removingId === row.id && (
        <div className="mt-3 flex items-center gap-2">
          <p className="text-xs text-status-rejected flex-1">
            Remove this entry permanently? This can't be undone.
          </p>
          <button
            disabled={busyId === row.id}
            onClick={() => onRemove(row)}
            className="px-3 py-1.5 rounded-md bg-status-rejected/20 text-status-rejected text-xs font-medium hover:bg-status-rejected/30 transition-colors disabled:opacity-50 shrink-0"
          >
            Yes, remove it
          </button>
          <button
            disabled={busyId === row.id}
            onClick={() => onToggleRemove(null)}
            className="px-3 py-1.5 rounded-md border border-border text-text-muted text-xs font-medium hover:text-text-primary transition-colors disabled:opacity-50 shrink-0"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

export default function AdminAlternateFormatsPage() {
  const [tab, setTab] = useState<'PENDING' | 'APPROVED' | 'REJECTED'>('PENDING');
  const [rows, setRows] = useState<FormatRow[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [removingId, setRemovingId] = useState<string | null>(null);

  // "Match a file" — independent of whatever's loaded into `rows` above
  // (that's scoped to one tab/status; this searches all three at once).
  const [matching, setMatching] = useState(false);
  const [matchSearching, setMatchSearching] = useState(false);
  const [matchedRow, setMatchedRow] = useState<FormatRow | null>(null);
  const [matchNotFound, setMatchNotFound] = useState<ROMFileInfo | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    fetch(`/api/admin/alternate-formats?status=${tab}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((data) => {
        setRows(data.items ?? []);
        setPendingCount(data.pendingCount ?? 0);
      })
      .catch(() => setError('Failed to load alternate formats'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [tab]);

  const review = async (row: FormatRow, approve: boolean, verifiedHash?: { crc32: string; md5: string; sha1: string }) => {
    setBusyId(row.id);
    setError(null);
    try {
      const res = await fetch(`/api/submissions/${row.submissionId}/formats/${row.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve, rejectionReason: approve ? undefined : (rejectReason || undefined), verifiedHash }),
      });
      if (!res.ok) { const d = await res.json(); setError(d.error ?? (approve ? 'Approve failed' : 'Reject failed')); return; }
      setRejectingId(null);
      setRejectReason('');
      setMatchedRow(null); // the matched-row card no longer reflects reality once acted on; drop it rather than show stale info
      load();
    } catch {
      setError('Network error');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (row: FormatRow) => {
    setBusyId(row.id);
    setError(null);
    try {
      const res = await fetch(`/api/submissions/${row.submissionId}/formats/${row.id}`, { method: 'DELETE' });
      if (!res.ok) { const d = await res.json(); setError(d.error ?? 'Remove failed'); return; }
      setRemovingId(null);
      setMatchedRow(null);
      load();
    } catch {
      setError('Network error');
    } finally {
      setBusyId(null);
    }
  };

  const handleMatchFile = async (info: ROMFileInfo) => {
    setMatching(false);
    setMatchSearching(true);
    setMatchedRow(null);
    setMatchNotFound(null);
    setError(null);
    try {
      const results = await Promise.all(
        (['PENDING', 'APPROVED', 'REJECTED'] as const).map((s) =>
          fetch(`/api/admin/alternate-formats?status=${s}`).then((r) => (r.ok ? r.json() : { items: [] }))
        )
      );
      const all: FormatRow[] = results.flatMap((d) => d.items ?? []);
      const found = all.find((r) => r.sha1.toLowerCase() === info.sha1.toLowerCase());
      if (found) {
        setMatchedRow(found);
        // Auto-verify immediately when there's actually something to verify
        // — mirrors AlternateFormats.tsx's own per-entry auto-verify (see
        // that component and the review route's `verifiedHash` handling).
        // No self-review check needed here specifically: this whole page
        // is already gated to Administrators only (admin/layout.tsx), and
        // an Administrator is exempt from that check everywhere (see
        // section 2at) — every admin who can even load this page can act
        // on every row on it, including one they added themselves.
        if (found.status === 'PENDING') {
          review(found, true, { crc32: info.crc32, md5: info.md5, sha1: info.sha1 });
        }
      } else {
        setMatchNotFound(info);
      }
    } catch {
      setError('Failed to search for a match');
    } finally {
      setMatchSearching(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl font-bold">Alternate formats</h1>
        <p className="text-text-secondary text-sm mt-1 max-w-2xl">
          Other compressed/container copies (RVZ, CHD, etc.) people have registered against already-approved hacks.
          Confirming one means you've separately decoded it yourself and checked it matches the hashes on that
          hack's own page — or that you dropped a copy below and it matched exactly.
        </p>
      </div>

      <div className="p-4 rounded-lg border border-border bg-bg-surface space-y-3">
        <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
          <UploadCloud size={15} className="text-phosphor" /> Match a file
        </h2>
        <p className="text-xs text-text-muted">
          Have a batch of files to get through? Drop one here — it's hashed locally, then checked against every
          entry regardless of which tab it's sitting in, so you don't need to know which hack it belongs to first.
        </p>

        {!matching && !matchSearching && !matchedRow && !matchNotFound && (
          <button
            type="button"
            onClick={() => setMatching(true)}
            className="inline-flex items-center gap-1.5 text-xs text-phosphor hover:underline"
          >
            <UploadCloud size={13} /> Drop a file to find its entry
          </button>
        )}

        {matching && (
          <div className="space-y-2 max-w-md">
            <ROMProcessor
              onFileProcessed={handleMatchFile}
              showUseButton={false}
              label="Drop the file you want to match"
              hint="Hashed locally in your browser — never uploaded"
            />
            <button type="button" onClick={() => setMatching(false)} className="text-xs text-text-muted hover:text-text-primary underline">
              Cancel
            </button>
          </div>
        )}

        {matchSearching && <p className="text-xs text-text-muted">Searching pending, verified, and rejected entries…</p>}

        {matchNotFound && (
          <div className="p-3 rounded-md border border-status-rejected/30 bg-status-rejected-bg space-y-1.5">
            <p className="text-xs text-status-rejected flex items-center gap-1.5 font-medium">
              <SearchX size={13} /> No entry — pending, verified, or rejected — matches this file's hash
            </p>
            <p className="text-[11px] text-text-muted font-mono truncate">{matchNotFound.filename} · SHA1 {matchNotFound.sha1}</p>
            <p className="text-[11px] text-text-secondary">
              If this is meant to be a NEW alternate format nobody's registered yet, add it from the hack's own page instead.
            </p>
            <button type="button" onClick={() => setMatchNotFound(null)} className="text-[11px] text-text-muted hover:text-text-primary underline">
              Try another file
            </button>
          </div>
        )}

        {matchedRow && (
          <div className="space-y-2">
            <p className="text-xs text-status-approved flex items-center gap-1.5 font-medium">
              <CheckCircle2 size={13} />
              {matchedRow.status === 'PENDING'
                ? (busyId === matchedRow.id ? 'Found a match — verifying automatically…' : 'Found a match — verified automatically')
                : `Found a match — already ${matchedRow.status === 'REJECTED' ? 'rejected' : 'verified'}`}
            </p>
            <RowCard
              row={matchedRow}
              busyId={busyId}
              rejectingId={rejectingId}
              rejectReason={rejectReason}
              removingId={removingId}
              onSetRejectReason={setRejectReason}
              onReview={review}
              onRemove={remove}
              onToggleReject={setRejectingId}
              onToggleRemove={setRemovingId}
            />
            <button type="button" onClick={() => setMatchedRow(null)} className="text-[11px] text-text-muted hover:text-text-primary underline">
              Clear
            </button>
          </div>
        )}
      </div>

      <div className="flex gap-1 p-1 rounded-lg bg-bg-surface border border-border w-fit">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${
              tab === t.key ? 'bg-phosphor/15 text-phosphor' : 'text-text-muted hover:text-text-primary'
            }`}
          >
            {t.label}
            {t.key === 'PENDING' && pendingCount > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-phosphor/20 text-phosphor text-[10px] font-bold">{pendingCount}</span>
            )}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-status-rejected">{error}</p>}
      {loading && <p className="text-sm text-text-muted">Loading…</p>}

      {!loading && rows.length === 0 && (
        <p className="text-sm text-text-muted">Nothing here.</p>
      )}

      <div className="space-y-2">
        {rows.map((r) => (
          <RowCard
            key={r.id}
            row={r}
            busyId={busyId}
            rejectingId={rejectingId}
            rejectReason={rejectReason}
            removingId={removingId}
            onSetRejectReason={setRejectReason}
            onReview={review}
            onRemove={remove}
            onToggleReject={setRejectingId}
            onToggleRemove={setRemovingId}
          />
        ))}
      </div>
    </div>
  );
}
