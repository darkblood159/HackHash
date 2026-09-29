'use client';

// src/app/admin/authors/page.tsx
//
// Admin management for the shared Author list (see the Author model in
// prisma/schema.prisma). Modeled directly on /admin/franchises — same
// Pending/Approved tab pair, approve, inline rename, merge-instead-of-
// reject, remove-never-blocked reasoning (an author has no hash to verify,
// so the moderation problem is "is this a duplicate of one we already
// have," not "is this wrong"). Admins can also add an author directly
// (created already approved) — handy for seeding the initial list.

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { UserSquare2, CheckCircle2, Pencil, Trash2, GitMerge, Plus, UserPlus, RefreshCw } from 'lucide-react';
import { AuthorPicker, type SelectedAuthor } from '@/components/AuthorPicker';

interface AuthorRow {
  id: string;
  name: string;
  status: 'PENDING' | 'APPROVED';
  createdAt: string;
  submittedByName: string | null;
  submissionCount: number;
}

interface BackfillResult {
  authorsCreated: number;
  authorsPromoted: number;
  authorsReused: number;
  submissionsLinked: number;
  skippedTotal: number;
  skippedSample: string[];
  failedGroups: Array<{ name: string; error: string }>;
}

const TABS = [
  { key: 'PENDING', label: 'Pending review' },
  { key: 'APPROVED', label: 'Approved' },
] as const;

export default function AdminAuthorsPage() {
  const [tab, setTab] = useState<'PENDING' | 'APPROVED'>('PENDING');
  const [rows, setRows] = useState<AuthorRow[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [unlinkedCount, setUnlinkedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [mergingId, setMergingId] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState<SelectedAuthor | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<BackfillResult | null>(null);

  const load = useCallback(async (which: 'PENDING' | 'APPROVED') => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/authors?status=${which}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load');
      setRows(data.authors);
      setPendingCount(data.pendingCount);
      setUnlinkedCount(data.unlinkedCount);
    } catch (e: any) {
      setError(e.message ?? 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(tab); }, [tab, load]);

  const runBackfill = async () => {
    setBackfilling(true);
    setBackfillResult(null);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/authors/backfill', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Linking failed'); return; }
      setBackfillResult(data);
      await load(tab);
    } catch {
      setError('Network error linking existing authors');
    } finally {
      setBackfilling(false);
    }
  };

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

  async function addAuthor() {
    const name = newName.trim();
    if (!name) return;
    setAdding(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/authors', jsonInit('POST', { name }));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Could not add author');
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
        <h1 className="font-display text-2xl font-bold flex items-center gap-2"><UserSquare2 size={22} /> Authors</h1>
        <p className="text-sm text-text-secondary mt-1 max-w-2xl">
          The shared list submitters pick from when crediting a hack&apos;s author. New ones they propose land here as
          pending. If two entries turn out to be the same person, merge them — every hack moves to the one you keep.
        </p>
      </div>

      {!loading && unlinkedCount > 0 && (
        <div className="p-5 rounded-lg border border-border bg-bg-surface">
          <div className="flex items-center gap-2 mb-2">
            <UserPlus size={16} className="text-phosphor" />
            <h2 className="text-sm font-semibold text-text-primary">Link existing authors</h2>
          </div>
          <p className="text-xs text-text-muted mb-3">
            {unlinkedCount} hack{unlinkedCount === 1 ? ' has a' : 's have'} credited author that predates this list, so it
            doesn&apos;t show up below yet. Safe to run any time — only touches submissions with no linked author yet,
            and doesn&apos;t change any hack&apos;s credited name beyond matching up near-identical spellings (e.g. two
            different capitalizations of the same handle) under one entry.
          </p>
          <button
            disabled={backfilling}
            onClick={runBackfill}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-phosphor/10 border border-phosphor/30 text-phosphor text-sm font-medium hover:bg-phosphor/20 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={backfilling ? 'animate-spin' : ''} />
            {backfilling ? 'Linking…' : `Link ${unlinkedCount} existing author${unlinkedCount === 1 ? '' : 's'}`}
          </button>
          {backfillResult && (
            <div className="text-sm text-text-primary mt-3 space-y-1">
              <p>
                Linked {backfillResult.submissionsLinked} hack{backfillResult.submissionsLinked === 1 ? '' : 's'} to{' '}
                {backfillResult.authorsCreated + backfillResult.authorsPromoted + backfillResult.authorsReused} author
                {backfillResult.authorsCreated + backfillResult.authorsPromoted + backfillResult.authorsReused === 1 ? '' : 's'}{' '}
                ({backfillResult.authorsCreated} new, {backfillResult.authorsReused} already listed
                {backfillResult.authorsPromoted > 0 && <>, {backfillResult.authorsPromoted} approved along the way</>}).
              </p>
              {backfillResult.skippedTotal > 0 && (
                <p className="text-text-muted">
                  Left {backfillResult.skippedTotal} hack{backfillResult.skippedTotal === 1 ? '' : 's'} as-is — the credited
                  text had nothing to match on (e.g. &ldquo;{backfillResult.skippedSample[0]}&rdquo;
                  {backfillResult.skippedSample.length > 1 && <>, &ldquo;{backfillResult.skippedSample[1]}&rdquo;</>}).
                </p>
              )}
              {backfillResult.failedGroups.length > 0 && (
                <p className="text-status-rejected">
                  {backfillResult.failedGroups.length} name{backfillResult.failedGroups.length === 1 ? '' : 's'} hit an
                  error and were left unlinked — safe to run again.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 max-w-md">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addAuthor(); }}
          placeholder="Add an author (created as approved)…"
          className="flex-1 px-3 py-2 rounded-md bg-bg-surface border border-border text-text-primary text-sm placeholder:text-text-muted focus:border-phosphor/50"
        />
        <button
          type="button"
          onClick={addAuthor}
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
          {tab === 'PENDING' ? 'Nothing waiting for review.' : 'No approved authors yet — add one above.'}
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
                          onClick={() => call(r.id, `/api/admin/authors/${r.id}`, jsonInit('PATCH', { name: editName }), () => 'Renamed.')}
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
                      <Link href={`/submissions?author=${encodeURIComponent(r.name)}`} className="hover:text-phosphor hover:underline">
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
                        onClick={() => call(r.id, `/api/admin/authors/${r.id}`, jsonInit('PATCH', { approve: true }), () => 'Approved.')}
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
                      Move {r.submissionCount === 1 ? 'its 1 hack' : `all ${r.submissionCount} hacks`} to another author, then delete &ldquo;{r.name}&rdquo;.
                    </p>
                    <AuthorPicker
                      value={mergeTarget}
                      onChange={setMergeTarget}
                      allowCreate={false}
                      excludeId={r.id}
                      placeholder="Search for the author to keep…"
                    />
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        disabled={busy || !mergeTarget}
                        onClick={() =>
                          call(
                            r.id,
                            `/api/admin/authors/${r.id}/merge`,
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
                        ? `${r.submissionCount} ${r.submissionCount === 1 ? 'hack' : 'hacks'} will simply lose the link to this approved author (their credited name stays as-is, nothing else about them changes). To keep them grouped under one name, merge instead.`
                        : 'No hacks use it.'}
                    </p>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          call(r.id, `/api/admin/authors/${r.id}`, { method: 'DELETE' }, (d) =>
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
