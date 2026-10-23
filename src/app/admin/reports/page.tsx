'use client';

// src/app/admin/reports/page.tsx
//
// Review queue for "Report issue" reports (broken links, patches that won't
// apply, wrong info, duplicates…). Open reports are the admin's to-do list; the
// same OPEN count drives the badge on the admin nav and the navbar's Admin
// link. Tabbed Open / Resolved / Dismissed like the other queues, plus a type
// filter. "Resolve all N" closes every open report on an entry in one tap —
// the usual case when several people hit the same dead link.
import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Flag, CheckCircle2, XCircle, RotateCcw } from 'lucide-react';
import { ISSUE_TYPES, issueTypeLabel } from '@/lib/issueReports';

interface Person { id: string; name: string | null; username: string | null }
interface ReportRow {
  id: string;
  submissionId: string;
  type: string;
  comment: string | null;
  status: 'OPEN' | 'RESOLVED' | 'DISMISSED';
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  duplicateOfId: string | null;
  openOnEntry: number;
  user: Person;
  resolvedBy: Person | null;
  original: { id: string; hackName: string; version: string } | null;
  submission: { hackName: string; version: string; platform: string };
}
type Tab = 'OPEN' | 'RESOLVED' | 'DISMISSED';
const TABS: { key: Tab; label: string }[] = [
  { key: 'OPEN', label: 'Open' },
  { key: 'RESOLVED', label: 'Resolved' },
  { key: 'DISMISSED', label: 'Dismissed' },
];

function who(u: Person | null): string {
  return u ? u.name ?? u.username ?? 'someone' : 'someone';
}

function ReportCard({ r, onAct }: { r: ReportRow; onAct: (id: string, action: 'resolve' | 'dismiss' | 'reopen', opts: { note?: string; allOnEntry?: boolean }) => Promise<void> }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (action: 'resolve' | 'dismiss' | 'reopen', allOnEntry = false) => {
    setBusy(true);
    try { await onAct(r.id, action, { note: note.trim() || undefined, allOnEntry }); } finally { setBusy(false); }
  };
  const btn = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs font-medium disabled:opacity-50 transition-colors';

  return (
    <div className="p-4 rounded-lg border border-border bg-bg-surface space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="px-2 py-0.5 rounded-full bg-status-disputed-bg text-status-disputed text-[11px] font-semibold">{issueTypeLabel(r.type)}</span>
        <Link href={`/submissions/${r.submissionId}`} className="text-sm font-medium text-phosphor hover:underline break-words">
          {r.submission.hackName} <span className="text-text-muted font-normal">v{r.submission.version} · {r.submission.platform}</span>
        </Link>
        {r.status === 'OPEN' && r.openOnEntry > 1 && (
          <span className="text-[11px] text-text-muted">{r.openOnEntry} open reports on this entry</span>
        )}
      </div>

      {r.comment ? (
        <p className="text-sm text-text-secondary whitespace-pre-wrap break-words">{r.comment}</p>
      ) : (
        <p className="text-xs text-text-muted italic">No comment left.</p>
      )}

      {r.type === 'DUPLICATE' && r.original && (
        <p className="text-xs text-text-muted">
          Says it duplicates{' '}
          <Link href={`/submissions/${r.original.id}`} className="text-phosphor hover:underline">{r.original.hackName} v{r.original.version}</Link>
        </p>
      )}

      <p className="text-xs text-text-muted">
        Reported by {who(r.user)} · {new Date(r.createdAt).toLocaleString()}
        {r.status !== 'OPEN' && r.resolvedAt && (
          <> · {r.status === 'RESOLVED' ? 'resolved' : 'dismissed'} by {who(r.resolvedBy)} on {new Date(r.resolvedAt).toLocaleDateString()}</>
        )}
      </p>
      {r.status !== 'OPEN' && r.resolutionNote && (
        <p className="text-xs text-text-secondary whitespace-pre-wrap break-words">Note: {r.resolutionNote}</p>
      )}

      {r.status === 'OPEN' ? (
        <div className="space-y-2 pt-1">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="Note (optional)"
            aria-label="Note (optional)"
            className="w-full px-3 py-1.5 rounded-md bg-bg-base border border-border text-xs"
          />
          <div className="flex flex-wrap gap-2">
            <button disabled={busy} onClick={() => act('resolve')} className={`${btn} border-status-approved/40 text-status-approved hover:bg-status-approved-bg`}>
              <CheckCircle2 size={13} /> Resolve
            </button>
            <button disabled={busy} onClick={() => act('dismiss')} className={`${btn} border-border text-text-secondary hover:bg-bg-elevated`}>
              <XCircle size={13} /> Dismiss
            </button>
            {r.openOnEntry > 1 && (
              <button disabled={busy} onClick={() => act('resolve', true)} className={`${btn} border-status-approved/40 text-status-approved hover:bg-status-approved-bg`}>
                <CheckCircle2 size={13} /> Resolve all {r.openOnEntry} on this entry
              </button>
            )}
          </div>
        </div>
      ) : (
        <button disabled={busy} onClick={() => act('reopen')} className={`${btn} border-border text-text-secondary hover:bg-bg-elevated`}>
          <RotateCcw size={13} /> Reopen
        </button>
      )}
    </div>
  );
}

export default function AdminReportsPage() {
  const [tab, setTab] = useState<Tab>('OPEN');
  const [type, setType] = useState('');
  const [items, setItems] = useState<ReportRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({ OPEN: 0, RESOLVED: 0, DISMISSED: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ status: tab });
      if (type) qs.set('type', type);
      const res = await fetch(`/api/admin/reports?${qs}`);
      if (!res.ok) throw new Error('Could not load reports');
      const data = await res.json();
      setItems(data.items);
      setCounts(data.counts);
    } catch (e: any) {
      setError(e?.message ?? 'Could not load reports');
    } finally {
      setLoading(false);
    }
  }, [tab, type]);

  useEffect(() => { load(); }, [load]);

  const onAct = async (id: string, action: 'resolve' | 'dismiss' | 'reopen', opts: { note?: string; allOnEntry?: boolean }) => {
    setError(null);
    const res = await fetch(`/api/admin/reports/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...opts }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      setError(d?.error ?? 'That didn’t work');
    }
    await load();
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <Flag size={16} className="text-phosphor" />
        <h2 className="font-display text-lg font-bold">Reported issues</h2>
      </div>
      <p className="text-sm text-text-muted mb-5">Problems people have flagged on entries — dead links, patches that won’t apply, wrong info, duplicates.</p>

      <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={
                'px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-1.5 transition-colors ' +
                (tab === t.key ? 'bg-phosphor/10 text-phosphor' : 'text-text-secondary hover:bg-bg-elevated')
              }
            >
              {t.label}
              <span className={'px-1.5 py-0.5 rounded-full text-[10px] font-bold ' + (t.key === 'OPEN' && counts.OPEN > 0 ? 'bg-phosphor/20 text-phosphor' : 'bg-bg-elevated text-text-muted')}>
                {counts[t.key] ?? 0}
              </span>
            </button>
          ))}
        </div>
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          aria-label="Filter by type"
          className="px-3 py-1.5 rounded-md bg-bg-base border border-border text-sm"
        >
          <option value="">All types</option>
          {ISSUE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>

      {error && <p role="alert" className="text-sm text-status-rejected mb-3">{error}</p>}

      {loading ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-text-muted">{tab === 'OPEN' ? 'No open reports — nothing needs attention.' : 'Nothing here.'}</p>
      ) : (
        <div className="space-y-3">
          {items.map((r) => <ReportCard key={r.id} r={r} onAct={onAct} />)}
        </div>
      )}
    </div>
  );
}
