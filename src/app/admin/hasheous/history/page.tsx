'use client';

// src/app/admin/hasheous/history/page.tsx
import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download, Upload, Bot, User, CheckCircle2, XCircle, RefreshCw } from 'lucide-react';

interface SyncJobRow {
  id: string;
  direction: 'PULL' | 'PUSH';
  env: string;
  status: 'RUNNING' | 'DONE' | 'ERROR';
  triggeredBy: 'MANUAL' | 'SCHEDULER';
  triggeredByUser: { id: string; name: string | null; username: string | null } | null;
  total: number;
  processed: number;
  found: number;
  updated: number;
  notFound: number;
  pushed: number;
  skipped: number;
  failed: number;
  errorMessage: string | null;
  startedAt: string;
  finishedAt?: string;
}

function elapsed(startedAt: string, finishedAt?: string): string {
  const end = finishedAt ? new Date(finishedAt) : new Date();
  const secs = Math.round((end.getTime() - new Date(startedAt).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export default function HasheousHistoryPage() {
  const [items, setItems] = useState<SyncJobRow[]>([]);
  const [direction, setDirection] = useState<'ALL' | 'PULL' | 'PUSH'>('ALL');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), perPage: '25' });
    if (direction !== 'ALL') params.set('direction', direction);
    fetch(`/api/admin/hasheous/history?${params}`)
      .then((r) => r.json())
      .then((d) => { setItems(d.items ?? []); setTotalPages(d.totalPages ?? 1); })
      .finally(() => setLoading(false));
  }, [direction, page]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <Link href="/admin/hasheous" className="text-xs text-text-muted hover:text-phosphor flex items-center gap-1 mb-2">
            <ArrowLeft size={12} /> Back to Hasheous Sync
          </Link>
          <h1 className="font-display text-2xl font-bold">Sync history</h1>
          <p className="text-xs text-text-muted mt-1">
            Every pull and push — manual runs from this page, and the background scheduler (auto-pull every 6h, auto-push every 30min).
          </p>
        </div>
        <div className="flex rounded-md border border-border overflow-hidden text-xs">
          {(['ALL', 'PULL', 'PUSH'] as const).map((d) => (
            <button
              key={d}
              onClick={() => { setDirection(d); setPage(1); }}
              className={`px-3 py-1.5 ${direction === d ? 'bg-phosphor/15 text-phosphor' : 'text-text-muted hover:bg-bg-elevated'}`}
            >
              {d === 'ALL' ? 'All' : d === 'PULL' ? 'Pulls' : 'Pushes'}
            </button>
          ))}
        </div>
      </div>

      <div className="border border-border rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-bg-elevated">
            <tr>
              <th className="text-left px-3 py-2 font-medium text-text-muted">Direction</th>
              <th className="text-left px-3 py-2 font-medium text-text-muted">Triggered by</th>
              <th className="text-left px-3 py-2 font-medium text-text-muted">Env</th>
              <th className="text-left px-3 py-2 font-medium text-text-muted">Status</th>
              <th className="text-left px-3 py-2 font-medium text-text-muted">Results</th>
              <th className="text-left px-3 py-2 font-medium text-text-muted">Started</th>
              <th className="text-left px-3 py-2 font-medium text-text-muted">Duration</th>
            </tr>
          </thead>
          <tbody>
            {items.map((j) => (
              <tr key={j.id} className="border-t border-border-subtle">
                <td className="px-3 py-2">
                  <span className="flex items-center gap-1.5">
                    {j.direction === 'PULL' ? <Download size={12} className="text-phosphor" /> : <Upload size={12} className="text-phosphor" />}
                    {j.direction === 'PULL' ? 'Pull' : 'Push'}
                  </span>
                </td>
                <td className="px-3 py-2 text-text-secondary">
                  <span className="flex items-center gap-1.5">
                    {j.triggeredBy === 'SCHEDULER' ? <Bot size={12} className="text-text-muted" /> : <User size={12} className="text-text-muted" />}
                    {j.triggeredBy === 'SCHEDULER' ? 'Scheduler' : (j.triggeredByUser?.name ?? j.triggeredByUser?.username ?? 'Admin')}
                  </span>
                </td>
                <td className="px-3 py-2 text-text-muted font-mono">{j.env}</td>
                <td className="px-3 py-2">
                  {j.status === 'RUNNING' && <span className="flex items-center gap-1 text-status-pending"><RefreshCw size={11} className="animate-spin" /> Running</span>}
                  {j.status === 'DONE' && <span className="flex items-center gap-1 text-status-approved"><CheckCircle2 size={11} /> Done</span>}
                  {j.status === 'ERROR' && <span className="flex items-center gap-1 text-status-rejected" title={j.errorMessage ?? undefined}><XCircle size={11} /> Error</span>}
                </td>
                <td className="px-3 py-2 text-text-secondary">
                  {j.direction === 'PULL'
                    ? `${j.processed}/${j.total} · ${j.updated} updated · ${j.notFound} not found`
                    : `${j.processed}/${j.total} · ${j.pushed} pushed · ${j.skipped} skipped · ${j.failed} failed`}
                </td>
                <td className="px-3 py-2 text-text-muted">{new Date(j.startedAt).toLocaleString()}</td>
                <td className="px-3 py-2 text-text-muted">{elapsed(j.startedAt, j.finishedAt)}</td>
              </tr>
            ))}
            {!loading && items.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-text-muted">No sync runs yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 text-xs">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="px-2 py-1 rounded border border-border disabled:opacity-40">Prev</button>
          <span className="text-text-muted">Page {page} of {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="px-2 py-1 rounded border border-border disabled:opacity-40">Next</button>
        </div>
      )}
    </div>
  );
}
