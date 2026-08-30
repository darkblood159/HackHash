'use client';

// src/components/AdminActions.tsx
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from './ui/Button';
import { CheckCircle2, XCircle, AlertTriangle, Edit2, Trash2 } from 'lucide-react';
import { FamilyPicker, type SelectedFamily } from './FamilyPicker';

interface AdminActionsProps {
  submissionId: string;
  status: string;
  hackName: string;
  version: string;
  platform: string;
  currentFamily?: SelectedFamily | null;
  hasOtherVersions?: boolean;
}

export function AdminActions({ submissionId, status, hackName, version, platform, currentFamily = null, hasOtherVersions }: AdminActionsProps) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [machineName, setMachineName] = useState(`${hackName} (v${version})`);
  const [showApprove, setShowApprove] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-approval review fields — let an admin fix a wrong name or a wrong
  // family grouping right here instead of having to separately open
  // "Edit / rename" first and come back to approve afterward. Independent
  // of each other, and of "Machine name" below (the DAT entry's own name,
  // already editable here before this).
  const [hackNameDraft, setHackNameDraft] = useState(hackName);
  const [applyToAllVersions, setApplyToAllVersions] = useState(true);
  const [selectedFamily, setSelectedFamily] = useState<SelectedFamily | null>(currentFamily);

  const isTerminal = status === 'APPROVED' || status === 'REJECTED';

  const runAction = async (action: 'REJECT' | 'DISPUTE') => {
    setLoading(action);
    setError(null);
    try {
      const res = await fetch(`/api/admin/submissions/${submissionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, reason: reason || undefined }),
      });

      if (res.ok) {
        router.refresh();
        setShowReject(false);
        return;
      }

      const data = await res.json().catch(() => ({}));
      setError(data.error ?? `${action.toLowerCase()} failed — please try again`);
    } catch {
      setError('Network error — the request may not have gone through. Check the audit trail below before retrying.');
    } finally {
      setLoading(null);
    }
  };

  // Approval gets its own function rather than going through runAction: it
  // may need to fire a rename and/or a family reassignment FIRST — each its
  // own request against an existing, otherwise-unrelated endpoint — and
  // should only proceed to the actual approve call if those succeed,
  // bailing partway through with a clear "here's what did and didn't
  // happen yet" error otherwise.
  const confirmApprove = async () => {
    setLoading('APPROVE');
    setError(null);
    try {
      const trimmedName = hackNameDraft.trim();
      if (trimmedName && trimmedName !== hackName) {
        const res = await fetch(`/api/submissions/${submissionId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hackName: trimmedName, applyToAllVersions }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data.error ?? 'Renaming failed — approval was not started.');
          return;
        }
      }

      const familyChanged = (selectedFamily?.id ?? null) !== (currentFamily?.id ?? null);
      if (familyChanged) {
        const res = await fetch(`/api/admin/submissions/${submissionId}/family`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hackFamilyId: selectedFamily?.id ?? null }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data.error ?? 'Changing the family failed — approval was not started (any name change above was still saved).');
          return;
        }
      }

      const res = await fetch(`/api/admin/submissions/${submissionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'APPROVE', machineName }),
      });

      if (res.ok) {
        router.refresh();
        setShowApprove(false);
        return;
      }

      const data = await res.json().catch(() => ({}));
      setError(data.error ?? 'Approve failed — please try again');
    } catch {
      setError('Network error — the request may not have gone through. Check the audit trail below before retrying.');
    } finally {
      setLoading(null);
    }
  };

  // Deliberately separate from `status`/runAction: deleting hides the
  // submission from every public view (list, search, DAT export) regardless
  // of its review status, and is reversible from Admin → Submissions → Deleted.
  const deleteEntry = async () => {
    setLoading('DELETE');
    setError(null);
    try {
      const res = await fetch(`/api/submissions/${submissionId}`, { method: 'DELETE' });
      if (res.ok) {
        router.push('/admin/submissions');
        router.refresh();
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? 'Delete failed — please try again');
    } catch {
      setError('Network error — please try again');
    } finally {
      setLoading(null);
    }
  };

  const deleteSection = !showDeleteConfirm ? (
    <button
      onClick={() => setShowDeleteConfirm(true)}
      className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-status-rejected/30 text-status-rejected text-sm hover:border-status-rejected hover:bg-status-rejected/10 transition-colors"
    >
      <Trash2 size={14} /> Delete submission
    </button>
  ) : (
    <div className="p-5 rounded-lg border border-border bg-bg-surface space-y-3">
      <p className="text-xs text-text-muted">
        Hides this from everyone but administrators — restorable anytime from Admin → Submissions → Deleted.
      </p>
      <div className="flex gap-2">
        <Button size="sm" variant="danger" loading={loading === 'DELETE'} onClick={deleteEntry}>Confirm delete</Button>
        <Button size="sm" variant="ghost" onClick={() => setShowDeleteConfirm(false)}>Cancel</Button>
      </div>
    </div>
  );

  if (isTerminal) {
    return (
      <div className="space-y-3">
        <div className="p-5 rounded-lg border border-border bg-bg-elevated text-sm text-text-muted">
          This submission is in a terminal state ({status.toLowerCase()}).
        </div>
        {deleteSection}
      </div>
    );
  }

  return (
    <div className="space-y-3">
    <div className="p-5 rounded-lg border border-phosphor/30 bg-phosphor/5">
      <h2 className="text-xs font-semibold text-phosphor uppercase tracking-wider mb-3">Admin actions</h2>

      {error && (
        <div className="mb-3 p-2.5 rounded-md bg-status-rejected-bg border border-status-rejected/30 text-xs text-status-rejected">
          {error}
        </div>
      )}

      {!showApprove && !showReject && (
        <div className="flex flex-col gap-2">
          <Button size="sm" onClick={() => setShowApprove(true)}>
            <CheckCircle2 size={14} /> Approve
          </Button>
          <Button size="sm" variant="danger" onClick={() => setShowReject(true)}>
            <XCircle size={14} /> Reject
          </Button>
          <Button size="sm" variant="secondary" loading={loading === 'DISPUTE'} onClick={() => runAction('DISPUTE')}>
            <AlertTriangle size={14} /> Mark disputed
          </Button>
        </div>
      )}

      {showApprove && (
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-text-muted mb-1 flex items-center gap-1">
              <Edit2 size={11} /> Hack name
            </label>
            <input
              value={hackNameDraft}
              onChange={(e) => setHackNameDraft(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-bg-base border border-border text-sm"
            />
            {hasOtherVersions && (
              <label className="flex items-center gap-1.5 mt-1.5 text-xs text-text-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={applyToAllVersions}
                  onChange={(e) => setApplyToAllVersions(e.target.checked)}
                  className="accent-phosphor"
                />
                Rename all other versions of this hack to match
              </label>
            )}
          </div>

          <div>
            <label className="block text-xs text-text-muted mb-1">Family</label>
            <FamilyPicker
              platform={platform}
              excludeFamilyId={currentFamily?.id}
              value={selectedFamily}
              onChange={setSelectedFamily}
            />
          </div>

          <div>
            <label className="block text-xs text-text-muted mb-1 flex items-center gap-1">
              <Edit2 size={11} /> Machine name (DAT entry)
            </label>
            <input
              value={machineName}
              onChange={(e) => setMachineName(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-bg-base border border-border text-sm font-mono"
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" loading={loading === 'APPROVE'} onClick={confirmApprove}>Confirm approve</Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setShowApprove(false);
                setHackNameDraft(hackName);
                setSelectedFamily(currentFamily);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {showReject && (
        <div className="space-y-3">
          <textarea
            placeholder="Reason for rejection (visible in audit trail)"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full px-3 py-2 rounded-md bg-bg-base border border-border text-sm"
          />
          <div className="flex gap-2">
            <Button size="sm" variant="danger" loading={loading === 'REJECT'} onClick={() => runAction('REJECT')}>Confirm reject</Button>
            <Button size="sm" variant="ghost" onClick={() => setShowReject(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
    {deleteSection}
    </div>
  );
}
