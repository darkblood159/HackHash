'use client';

// src/app/admin/base-roms/page.tsx
import React, { useState, useEffect } from 'react';
import { Disc3, CheckCircle2, XCircle, Pencil, Trash2 } from 'lucide-react';
import { PLATFORMS, PLATFORM_LABELS } from '@/types';

interface BaseRomRow {
  id: string;
  platform: string;
  name: string;
  crc32: string;
  md5: string;
  sha1: string;
  status: string;
  createdAt: string;
  rejectionReason: string | null;
  submittedBy: { id: string; name: string | null } | null;
  _count: { submissions: number };
}

const TABS = [
  { key: 'PENDING', label: 'Pending review' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
] as const;

export default function AdminBaseRomsPage() {
  const [tab, setTab] = useState<'PENDING' | 'APPROVED' | 'REJECTED'>('PENDING');
  const [rows, setRows] = useState<BaseRomRow[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editPlatform, setEditPlatform] = useState('');
  const [removingId, setRemovingId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    fetch(`/api/admin/base-roms?status=${tab}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((data) => {
        setRows(data.baseRoms ?? []);
        setPendingCount(data.pendingCount ?? 0);
      })
      .catch(() => setError('Failed to load base ROMs'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [tab]);

  const approve = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/base-roms/${id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!res.ok) { const d = await res.json(); setError(d.error ?? 'Approve failed'); return; }
      load();
    } catch {
      setError('Network error');
    } finally {
      setBusyId(null);
    }
  };

  const startEditing = (r: BaseRomRow) => {
    setEditingId(r.id);
    setEditName(r.name);
    setEditPlatform(r.platform);
    setRejectingId(null);
    setRemovingId(null);
  };

  const saveEdit = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/base-roms/${id}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName.trim(), platform: editPlatform }),
      });
      if (!res.ok) { const d = await res.json(); setError(d.error ?? 'Save failed'); return; }
      setEditingId(null);
      load();
    } catch {
      setError('Network error');
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/base-roms/${id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: rejectReason || undefined }),
      });
      if (!res.ok) { const d = await res.json(); setError(d.error ?? 'Reject failed'); return; }
      setRejectingId(null);
      setRejectReason('');
      load();
    } catch {
      setError('Network error');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/base-roms/${id}/remove`, { method: 'POST' });
      if (!res.ok) { const d = await res.json(); setError(d.error ?? 'Remove failed'); return; }
      setRemovingId(null);
      load();
    } catch {
      setError('Network error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl font-bold">Base ROMs</h1>
        <p className="text-text-secondary text-sm mt-1 max-w-2xl">
          Submitters can hash and propose a base ROM directly from the submit form when the one they need isn't in the
          approved list yet. Their hack submission can go ahead while it's pending — review it here whenever.
        </p>
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
          <div key={r.id} className="p-4 rounded-lg border border-border bg-bg-surface">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="flex items-start gap-3">
                <Disc3 size={18} className="text-phosphor shrink-0 mt-0.5" />
                <div>
                  <p className="text-text-primary font-medium">{r.name}</p>
                  <p className="text-xs text-text-muted mt-0.5">
                    {r.platform} · submitted by {r.submittedBy?.name ?? 'unknown'} ·{' '}
                    {new Date(r.createdAt).toLocaleDateString()}
                    {r._count.submissions > 0 && <> · used by {r._count.submissions} submission{r._count.submissions === 1 ? '' : 's'}</>}
                  </p>
                  <p className="text-xs font-mono text-text-muted mt-1">
                    CRC32 {r.crc32} · MD5 {r.md5}
                  </p>
                  <p className="text-xs font-mono text-text-muted">SHA-1 {r.sha1}</p>
                  {r.status === 'REJECTED' && r.rejectionReason && (
                    <p className="text-xs text-status-rejected mt-1">Rejected: {r.rejectionReason}</p>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  disabled={busyId === r.id}
                  onClick={() => (editingId === r.id ? setEditingId(null) : startEditing(r))}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-text-muted text-xs font-medium hover:border-phosphor/40 hover:text-phosphor transition-colors disabled:opacity-50"
                >
                  <Pencil size={13} /> Edit
                </button>
                <button
                  disabled={busyId === r.id || r._count.submissions > 0}
                  title={r._count.submissions > 0 ? `Used by ${r._count.submissions} submission${r._count.submissions === 1 ? '' : 's'} — reassign them first` : undefined}
                  onClick={() => { setRemovingId(removingId === r.id ? null : r.id); setEditingId(null); setRejectingId(null); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-text-muted text-xs font-medium hover:border-status-rejected/40 hover:text-status-rejected transition-colors disabled:opacity-50 disabled:hover:border-border disabled:hover:text-text-muted"
                >
                  <Trash2 size={13} /> Remove
                </button>
                {tab === 'PENDING' && (
                  <>
                    <button
                      disabled={busyId === r.id}
                      onClick={() => approve(r.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-phosphor/15 border border-phosphor/40 text-phosphor text-xs font-medium hover:bg-phosphor/25 transition-colors disabled:opacity-50"
                    >
                      <CheckCircle2 size={13} /> Approve
                    </button>
                    <button
                      disabled={busyId === r.id}
                      onClick={() => { setRejectingId(rejectingId === r.id ? null : r.id); setEditingId(null); setRemovingId(null); }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-text-muted text-xs font-medium hover:border-status-rejected/40 hover:text-status-rejected transition-colors disabled:opacity-50"
                    >
                      <XCircle size={13} /> Reject
                    </button>
                  </>
                )}
              </div>
            </div>

            {editingId === r.id && (
              <div className="mt-3 flex flex-wrap gap-2">
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="Name"
                  className="flex-1 min-w-[180px] px-3 py-1.5 rounded-md bg-bg-base border border-border text-text-primary text-xs placeholder:text-text-muted focus:border-phosphor/50"
                />
                <select
                  value={editPlatform}
                  onChange={(e) => setEditPlatform(e.target.value)}
                  className="px-3 py-1.5 rounded-md bg-bg-base border border-border text-text-primary text-xs focus:border-phosphor/50"
                >
                  {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>)}
                </select>
                <button
                  disabled={busyId === r.id || !editName.trim()}
                  onClick={() => saveEdit(r.id)}
                  className="px-3 py-1.5 rounded-md bg-phosphor/15 border border-phosphor/40 text-phosphor text-xs font-medium hover:bg-phosphor/25 transition-colors disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  disabled={busyId === r.id}
                  onClick={() => setEditingId(null)}
                  className="px-3 py-1.5 rounded-md border border-border text-text-muted text-xs font-medium hover:text-text-primary transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            )}

            {rejectingId === r.id && (
              <div className="mt-3 flex gap-2">
                <input
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="Reason (optional)"
                  className="flex-1 px-3 py-1.5 rounded-md bg-bg-base border border-border text-text-primary text-xs placeholder:text-text-muted focus:border-phosphor/50"
                />
                <button
                  disabled={busyId === r.id}
                  onClick={() => reject(r.id)}
                  className="px-3 py-1.5 rounded-md bg-status-rejected/20 text-status-rejected text-xs font-medium hover:bg-status-rejected/30 transition-colors disabled:opacity-50"
                >
                  Confirm reject
                </button>
              </div>
            )}

            {removingId === r.id && (
              <div className="mt-3 flex items-center gap-2">
                <p className="text-xs text-status-rejected flex-1">
                  Remove this base ROM permanently? This can't be undone — the row itself is deleted, not just hidden.
                </p>
                <button
                  disabled={busyId === r.id}
                  onClick={() => remove(r.id)}
                  className="px-3 py-1.5 rounded-md bg-status-rejected/20 text-status-rejected text-xs font-medium hover:bg-status-rejected/30 transition-colors disabled:opacity-50 shrink-0"
                >
                  Yes, remove it
                </button>
                <button
                  disabled={busyId === r.id}
                  onClick={() => setRemovingId(null)}
                  className="px-3 py-1.5 rounded-md border border-border text-text-muted text-xs font-medium hover:text-text-primary transition-colors disabled:opacity-50 shrink-0"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
