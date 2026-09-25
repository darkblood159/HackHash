'use client';

// src/app/admin/franchises/page.tsx
//
// Admin management for the shared Franchise list (see the Franchise model
// in prisma/schema.prisma). Modeled on /admin/base-roms: a Pending/Approved
// tab pair, approve, inline rename, remove. Two differences that come from
// what a franchise is:
//   - "Merge into…" instead of reject. A franchise has no hash to verify,
//     so the real moderation problem isn't "is this wrong" but "is this a
//     duplicate of one we already have" — merging moves every hack over and
//     deletes the extra, which is the safety net behind the picker's own
//     duplicate-avoidance.
//   - Remove is never blocked. Franchise is optional on a submission, so
//     removing one just unlinks its hacks (they stay intact).
// Admins can also add a franchise directly (created already approved) —
// handy for seeding the initial list so submitters have something to pick.

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Library, CheckCircle2, Pencil, Trash2, GitMerge, Plus } from 'lucide-react';
import { FranchisePicker, type SelectedFranchise } from '@/components/FranchisePicker';

interface FranchiseRow {
  id: string;
  name: string;
  status: 'PENDING' | 'APPROVED';
  createdAt: string;
  submittedByName: string | null;
  submissionCount: number;
}

const TABS = [
  { key: 'PENDING', label: 'Pending review' },
  { key: 'APPROVED', label: 'Approved' },
] as const;

export default function AdminFranchisesPage() {
  const [tab, setTab] = useState<'PENDING' | 'APPROVED'>('PENDING');
  const [rows, setRows] = useState<FranchiseRow[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [mergingId, setMergingId] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState<SelectedFranchise | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async (which: 'PENDING' | 'APPROVED') => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/franchises?status=${which}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load');
      setRows(data.franchises);
      setPendingCount(data.pendingCount);
    } catch (e: any) {
      setError(e.message ?? 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(tab); }, [tab, load]);

  function resetInlineState() {
    setEditingId(null);
    setMergingId(null);
    setMergeTarget(null);
    setRemovingId(null);
  }

  async function call(id: string, url: string, init: RequestInit, successMessage?: (data: any) => string) {
    setBusyId(id);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(url, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Request failed');
        return false;
      }
      if (successMessage) setMessage(successMessage(data));
      resetInlineState();
      await load(tab);
      return true;
    } catch {
      setError('Network error — please try again');
      return false;
    } finally {
      setBusyId(null);
    }
  }

  const jsonInit = (method: string, body?: unknown): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  async function addFranchise() {
    const name = newName.trim();
    if (!name) return;
    setAdding(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/franchises', jsonInit('POST', { name }));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Could not add franchise');
        return;
      }
      setMessage(
        data.alreadyExisted
          ? `"${data.name}" already exists.`
          : data.promoted
            ? `"${data.name}" was already proposed — it's now approved.`
            : `Added "${data.name}".`
      );
      setNewName('');
      await load(tab);
    } catch {
      setError('Network error — please try again');
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl font-bold flex items-center gap-2"><Library size={22} /> Franchises</h1>
        <p className="text-sm text-text-secondary mt-1 max-w-2xl">
          The shared list submitters pick from when tagging a hack&apos;s franchise. New ones they propose land here
          as pending. If two entries turn out to be the same franchise, merge them — every hack moves to the one you keep.
        </p>
      </div>

      <div className="flex items-center gap-2 max-w-md">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addFranchise(); }}
          placeholder="Add a franchise (created as approved)…"
          className="flex-1 px-3 py-2 rounded-md bg-bg-surface border border-border text-text-primary text-sm placeholder:text-text-muted focus:border-phosphor/50"
        />
        <button
          type="button"
          onClick={addFranchise}
          disabled={adding || !newName.trim()}
          className="inline-flex items-center gap-1 px-3 py-2 rounded-md bg-phosphor text-text-inverse text-sm font-medium disabled:opacity-50"
        >
          <Plus size={14} /> Add
        </button>
      </div>

      <div className="flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => { resetInlineState(); setTab(t.key); }}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${
              tab === t.key ? 'border-phosphor text-phosphor' : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {t.label}
            {t.key === 'PENDING' && pendingCount > 0 && (
              <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-status-pending-bg text-status-pending">{pendingCount}</span>
            )}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-status-rejected">{error}</p>}
      {message && <p className="text-sm text-status-approved">{message}</p>}

      {loading ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-text-muted">
          {tab === 'PENDING' ? 'Nothing waiting for review.' : 'No approved franchises yet — add one above.'}
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const busy = busyId === r.id;
            return (
              <li key={r.id} className="rounded-lg border border-border bg-bg-surface p-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    {editingId === r.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="px-2 py-1 rounded-md bg-bg-base border border-border text-sm"
                        />
                        <button
                          type="button"
                          disabled={busy || !editName.trim()}
                          onClick={() => call(r.id, `/api/admin/franchises/${r.id}`, jsonInit('PATCH', { name: editName }), () => 'Renamed.')}
                          className="text-xs text-phosphor hover:underline disabled:opacity-50"
                        >
                          Save
                        </button>
                        <button type="button" onClick={() => setEditingId(null)} className="text-xs text-text-muted hover:underline">Cancel</button>
                      </div>
                    ) : (
                      <p className="font-medium text-text-primary">{r.name}</p>
                    )}
                    <p className="text-xs text-text-muted mt-0.5">
                      <Link href={`/submissions?franchise=${r.id}`} className="hover:text-phosphor hover:underline">
                        {r.submissionCount} {r.submissionCount === 1 ? 'hack' : 'hacks'}
                      </Link>
                      {r.submittedByName && <> · proposed by {r.submittedByName}</>}
                      {' · '}{new Date(r.createdAt).toLocaleDateString()}
                    </p>
                  </div>

                  <div className="flex items-center gap-3 flex-wrap text-xs">
                    {r.status === 'PENDING' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => call(r.id, `/api/admin/franchises/${r.id}`, jsonInit('PATCH', { approve: true }), () => 'Approved.')}
                        className="inline-flex items-center gap-1 text-status-approved hover:underline disabled:opacity-50"
                      >
                        <CheckCircle2 size={13} /> Approve
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => { resetInlineState(); setEditingId(r.id); setEditName(r.name); }}
                      className="inline-flex items-center gap-1 text-text-secondary hover:text-text-primary"
                    >
                      <Pencil size={13} /> Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => { resetInlineState(); setMergingId(r.id); }}
                      className="inline-flex items-center gap-1 text-text-secondary hover:text-text-primary"
                    >
                      <GitMerge size={13} /> Merge into…
                    </button>
                    <button
                      type="button"
                      onClick={() => { resetInlineState(); setRemovingId(r.id); }}
                      className="inline-flex items-center gap-1 text-text-muted hover:text-status-rejected"
                    >
                      <Trash2 size={13} /> Remove
                    </button>
                  </div>
                </div>

                {mergingId === r.id && (
                  <div className="mt-3 pt-3 border-t border-border space-y-2 max-w-md">
                    <p className="text-xs text-text-secondary">
                      Move {r.submissionCount === 1 ? 'its 1 hack' : `all ${r.submissionCount} hacks`} to another franchise, then delete &ldquo;{r.name}&rdquo;.
                    </p>
                    <FranchisePicker
                      value={mergeTarget}
                      onChange={setMergeTarget}
                      allowCreate={false}
                      excludeId={r.id}
                      placeholder="Search for the franchise to keep…"
                    />
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        disabled={busy || !mergeTarget}
                        onClick={() =>
                          call(
                            r.id,
                            `/api/admin/franchises/${r.id}/merge`,
                            jsonInit('POST', { intoId: mergeTarget!.id }),
                            (d) => `Merged — moved ${d.moved} ${d.moved === 1 ? 'hack' : 'hacks'} to "${mergeTarget!.name}".`
                          )
                        }
                        className="text-xs px-2.5 py-1 rounded-md bg-phosphor text-text-inverse font-medium disabled:opacity-50"
                      >
                        Merge
                      </button>
                      <button type="button" onClick={resetInlineState} className="text-xs text-text-muted hover:underline">Cancel</button>
                    </div>
                  </div>
                )}

                {removingId === r.id && (
                  <div className="mt-3 pt-3 border-t border-border space-y-2">
                    <p className="text-xs text-text-secondary">
                      Remove &ldquo;{r.name}&rdquo;?{' '}
                      {r.submissionCount > 0
                        ? `${r.submissionCount} ${r.submissionCount === 1 ? 'hack' : 'hacks'} will simply lose this franchise (nothing else about them changes). To keep them grouped, merge instead.`
                        : 'No hacks use it.'}
                    </p>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          call(r.id, `/api/admin/franchises/${r.id}`, { method: 'DELETE' }, (d) =>
                            `Removed${d.unlinkedSubmissions ? ` — ${d.unlinkedSubmissions} ${d.unlinkedSubmissions === 1 ? 'hack' : 'hacks'} unlinked` : ''}.`
                          )
                        }
                        className="text-xs px-2.5 py-1 rounded-md border border-status-rejected/40 text-status-rejected hover:bg-status-rejected-bg disabled:opacity-50"
                      >
                        Yes, remove
                      </button>
                      <button type="button" onClick={resetInlineState} className="text-xs text-text-muted hover:underline">Cancel</button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
