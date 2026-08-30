'use client';

// src/app/admin/hasheous/page.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { Upload, Download, RefreshCw, CheckCircle2, XCircle, AlertTriangle, ExternalLink, Clock, FileDown, History, ShieldCheck } from 'lucide-react';

type HasheousEnv = 'beta' | 'production';

interface JobEntry {
  id: string; hackName: string; sha1: string; mappingsApplied?: string[];
}
interface PullJob {
  id: string;
  status: 'pending' | 'running' | 'done' | 'error';
  env: string;
  total: number;
  processed: number;
  found: number;
  updated: number;
  notFound: number;
  startedAt: string;
  finishedAt?: string;
  foundResults: JobEntry[];
  notFoundResults: JobEntry[];
}

interface PushResult { id: string; hackName: string; sha1: string; ok: boolean; skipped?: boolean; skipReason?: string; error?: string; sentMappings?: Record<string, string>; }
interface PushResponse { env: string; baseUrl: string; total: number; pushed: number; skipped: number; failed: number; results: PushResult[]; }

const ENV_URLS: Record<HasheousEnv, string> = {
  beta: 'https://beta.hasheous.org',
  production: 'https://hasheous.org',
};

interface PushVerificationSummary {
  pending: number;
  confirmed: number;
  notReflected: number;
  notReflectedItems: { gameMappingId: string; pushedAt: string | null; submissionId: string | null; hackName: string }[];
}

const LAST_JOB_KEY = 'hackhash_hasheous_last_job_id';

function elapsed(startedAt: string, finishedAt?: string): string {
  const end = finishedAt ? new Date(finishedAt) : new Date();
  const secs = Math.round((end.getTime() - new Date(startedAt).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export default function AdminHasheousPage() {
  const [env, setEnv] = useState<HasheousEnv>('beta');
  const [apiKeySet, setApiKeySet] = useState<boolean | null>(null);
  const [onlyMissing, setOnlyMissing] = useState(true);
  const [skipSynced, setSkipSynced] = useState(true);
  // AUG-28: previously never sent at all — the route already defaulted to
  // false, so this was already always a safe/fill-only bulk pull, just with
  // no way to explicitly choose otherwise from this page. Defaulting to
  // false here preserves that exact existing behavior; this just makes it
  // an explicit, visible choice instead of an invisible default, and adds
  // the option to deliberately run an overwrite bulk pull when that's
  // actually wanted (previously only possible by calling the API directly).
  const [overwrite, setOverwrite] = useState(false);
  const [pullLimit, setPullLimit] = useState(500);
  const [delayMs, setDelayMs] = useState(800);
  const [resultsTab, setResultsTab] = useState<'updated' | 'found' | 'notfound'>('updated');

  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState<PushResponse | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);

  const [activeJob, setActiveJob] = useState<PullJob | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [verification, setVerification] = useState<PushVerificationSummary | null>(null);

  useEffect(() => {
    fetch('/api/admin/hasheous/push-verification')
      .then((r) => (r.ok ? r.json() : null))
      .then(setVerification)
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/admin/hasheous/status')
      .then((r) => r.json())
      .then((d) => {
        setApiKeySet(d.apiKeyConfigured);
        // Default to whatever HASHEOUS_ENV is set to in .env, not always beta
        if (d.env) setEnv(d.env as HasheousEnv);
      })
      .catch(() => setApiKeySet(false));
  }, []);

  // On mount: if there's a job we were watching (even from a previous page
  // visit), resume tracking it. The job itself runs entirely server-side and
  // was NEVER actually stopped by navigating away — only the browser's
  // knowledge of it was lost. This restores that.
  useEffect(() => {
    const lastId = typeof window !== 'undefined' ? localStorage.getItem(LAST_JOB_KEY) : null;
    if (!lastId) { setResuming(false); return; }

    fetch(`/api/admin/hasheous/pull/status?id=${lastId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && !data.error) {
          setActiveJob(data);
          setEnv(data.env as HasheousEnv);
        } else {
          localStorage.removeItem(LAST_JOB_KEY);
        }
      })
      .catch(() => {})
      .finally(() => setResuming(false));
  }, []);

  // Poll while running
  useEffect(() => {
    if (!activeJob || !['pending', 'running'].includes(activeJob.status)) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    pollRef.current = setInterval(async () => {
      const res = await fetch(`/api/admin/hasheous/pull/status?id=${activeJob.id}`);
      if (res.ok) setActiveJob(await res.json());
    }, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [activeJob?.id, activeJob?.status]);

  const startPull = async () => {
    setPullError(null);
    setActiveJob(null);
    try {
      const res = await fetch('/api/admin/hasheous/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env, onlyMissing, skipSynced, overwrite, limit: pullLimit, delayMs }),
      });
      const data = await res.json();
      if (!res.ok) { setPullError(data.error ?? 'Failed to start'); return; }
      localStorage.setItem(LAST_JOB_KEY, data.jobId);
      setActiveJob({
        id: data.jobId, status: 'pending', env, total: data.total, processed: 0,
        found: 0, updated: 0, notFound: 0, startedAt: new Date().toISOString(),
        foundResults: [], notFoundResults: [],
      });
    } catch { setPullError('Network error starting pull'); }
  };

  const startPush = async () => {
    setPushing(true); setPushError(null); setPushResult(null);
    try {
      const res = await fetch('/api/admin/hasheous/push', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ env }),
      });
      const data = await res.json();
      if (!res.ok) setPushError(data.error ?? 'Push failed');
      else {
        setPushResult(data);
        fetch('/api/admin/hasheous/push-verification').then((r) => (r.ok ? r.json() : null)).then(setVerification).catch(() => {});
      }
    } catch { setPushError('Network error'); }
    finally { setPushing(false); }
  };

  const isJobRunning = activeJob && ['pending', 'running'].includes(activeJob.status);
  const pct = activeJob && activeJob.total > 0 ? Math.round((activeJob.processed / activeJob.total) * 100) : 0;
  const eta = activeJob && activeJob.status === 'running' && activeJob.processed > 0
    ? Math.round(((activeJob.total - activeJob.processed) * delayMs) / 1000) : null;

  const updatedList = activeJob?.foundResults.filter((r) => (r.mappingsApplied?.length ?? 0) > 0) ?? [];
  const foundNoDataList = activeJob?.foundResults.filter((r) => !(r.mappingsApplied?.length)) ?? [];
  const notFoundList = activeJob?.notFoundResults ?? [];

  const activeList = resultsTab === 'updated' ? updatedList : resultsTab === 'found' ? foundNoDataList : notFoundList;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl font-bold">Hasheous Sync</h1>
        <p className="text-text-secondary text-sm mt-1 max-w-2xl">
          Pull game mapping IDs from Hasheous into your approved entries, or push your mapping data
          back so other tools benefit. Pulls run in the background — safe to navigate away.
        </p>
      </div>

      {apiKeySet === false && (
        <div className="p-4 rounded-lg bg-status-pending-bg border border-status-pending/30 flex items-start gap-3">
          <AlertTriangle size={16} className="text-status-pending shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="text-status-pending font-medium">HASHEOUS_API_KEY not configured</p>
            <p className="text-text-secondary mt-1">
              Pull (read) works without a key. Push (FixMatch) requires{' '}
              <code className="font-mono text-xs bg-bg-base px-1 rounded">HASHEOUS_API_KEY</code> in <code className="font-mono text-xs bg-bg-base px-1 rounded">.env</code>.
            </p>
          </div>
        </div>
      )}

      <div className="p-5 rounded-lg border border-border bg-bg-surface">
        <h2 className="text-sm font-semibold text-text-primary mb-3">Environment</h2>
        <div className="flex gap-2">
          {(['beta', 'production'] as const).map((e) => (
            <button key={e} onClick={() => setEnv(e)} disabled={!!isJobRunning}
              className={`px-4 py-2 rounded-md text-sm font-medium border transition-colors disabled:opacity-50 ${
                env === e ? 'bg-phosphor/15 border-phosphor/40 text-phosphor' : 'border-border text-text-secondary hover:border-phosphor/30'
              }`}>
              {e.charAt(0).toUpperCase() + e.slice(1)}
            </button>
          ))}
        </div>
        <p className="text-xs text-text-muted mt-2">
          Active: <a href={ENV_URLS[env]} target="_blank" rel="noreferrer" className="text-phosphor hover:underline font-mono">{ENV_URLS[env]}</a>
        </p>
      </div>

      {verification && (verification.pending > 0 || verification.confirmed > 0 || verification.notReflected > 0) && (
        <div className="p-5 rounded-lg border border-border bg-bg-surface">
          <div className="flex items-center gap-2 mb-3">
            <ShieldCheck size={16} className="text-phosphor" />
            <h2 className="text-sm font-semibold text-text-primary">Push verification</h2>
          </div>
          <p className="text-xs text-text-muted mb-3">
            Whether pushes actually took effect on Hasheous's end. A push is a community vote there, not a direct edit — it applies immediately if Hasheous had nothing mapped yet, otherwise it needs 2 more people to independently agree before it can override an existing match. Checked automatically on the next background pull after each push, no need to check back yourself.
          </p>
          <div className="grid grid-cols-3 gap-3 text-center mb-2">
            <div className="p-2 rounded bg-bg-elevated">
              <p className="text-lg font-bold text-status-pending">{verification.pending}</p>
              <p className="text-[10px] text-text-muted uppercase tracking-wider">Awaiting confirmation</p>
            </div>
            <div className="p-2 rounded bg-bg-elevated">
              <p className="text-lg font-bold text-status-approved">{verification.confirmed}</p>
              <p className="text-[10px] text-text-muted uppercase tracking-wider">Confirmed</p>
            </div>
            <div className="p-2 rounded bg-bg-elevated">
              <p className="text-lg font-bold text-status-rejected">{verification.notReflected}</p>
              <p className="text-[10px] text-text-muted uppercase tracking-wider">Not reflected</p>
            </div>
          </div>
          {verification.notReflectedItems.length > 0 && (
            <div className="mt-3 border border-status-rejected/30 rounded-lg overflow-hidden">
              <div className="px-3 py-1.5 bg-status-rejected-bg text-[10px] text-status-rejected uppercase tracking-wider font-medium">
                Pushed 48h+ ago, still unconfirmed — likely needs more community votes to override an existing match (or was rejected outright; check sync history)
              </div>
              <div className="max-h-40 overflow-y-auto">
                {verification.notReflectedItems.map((item) => (
                  <a
                    key={item.gameMappingId}
                    href={item.submissionId ? `/submissions/${item.submissionId}` : undefined}
                    className={`flex items-center justify-between px-3 py-1.5 text-xs border-t border-border-subtle ${item.submissionId ? 'hover:bg-bg-elevated text-text-primary' : 'text-text-muted pointer-events-none'}`}
                  >
                    <span>{item.hackName}</span>
                    {item.pushedAt && (
                      <span className="text-text-muted font-mono text-[10px]">
                        pushed {new Date(item.pushedAt).toLocaleDateString()}
                      </span>
                    )}
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-4">
        <div className="p-5 rounded-lg border border-border bg-bg-surface">
          <div className="flex items-center gap-2 mb-2">
            <Upload size={16} className="text-phosphor" />
            <h2 className="text-sm font-semibold text-text-primary">Push mappings</h2>
          </div>
          <p className="text-xs text-text-muted mb-4">Send your mapping IDs to Hasheous for approved entries that have them.</p>
          <button disabled={pushing} onClick={startPush}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-phosphor/10 border border-phosphor/30 text-phosphor text-sm font-medium hover:bg-phosphor/20 transition-colors disabled:opacity-50">
            {pushing ? <RefreshCw size={14} className="animate-spin" /> : <Upload size={14} />}
            {pushing ? 'Pushing…' : 'Push to Hasheous'}
          </button>
          {pushError && <p className="text-xs text-status-rejected mt-2">{pushError}</p>}
          {pushResult && (
            <div className="mt-3 space-y-2">
              <p className="text-xs text-status-approved">
                Pushed {pushResult.pushed}/{pushResult.total}
                {pushResult.skipped > 0 && `, ${pushResult.skipped} skipped`}
                {pushResult.failed > 0 && `, ${pushResult.failed} failed`}
              </p>
              {pushResult.results.length > 0 && (
                <div className="border border-border rounded-lg max-h-56 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-bg-elevated sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium text-text-muted">Entry</th>
                        <th className="text-left px-3 py-2 font-medium text-text-muted">Result</th>
                        <th className="text-left px-3 py-2 font-medium text-text-muted">Data sent</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pushResult.results.map((r) => (
                        <tr key={r.id} className="border-t border-border-subtle">
                          <td className="px-3 py-1.5 text-text-primary">
                            {r.hackName}
                            <span className="block text-text-muted font-mono text-[10px]">{r.sha1.slice(0, 12)}…</span>
                          </td>
                          <td className="px-3 py-1.5">
                            {r.ok && <span className="text-status-approved">✓ Pushed</span>}
                            {r.skipped && <span className="text-text-muted">{r.skipReason}</span>}
                            {!r.ok && !r.skipped && <span className="text-status-rejected">{r.error}</span>}
                          </td>
                          <td className="px-3 py-1.5 text-text-muted">
                            {r.sentMappings ? Object.keys(r.sentMappings).join(', ') : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="p-5 rounded-lg border border-border bg-bg-surface">
          <div className="flex items-center gap-2 mb-2">
            <Download size={16} className="text-phosphor" />
            <h2 className="text-sm font-semibold text-text-primary">Pull mappings</h2>
          </div>
          <p className="text-xs text-text-muted mb-3">Sends CRC32+MD5+SHA1 per entry. 429s retried with backoff.</p>
          <div className="space-y-2 mb-3">
            <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
              <input type="checkbox" checked={skipSynced} onChange={(e) => setSkipSynced(e.target.checked)} disabled={!!isJobRunning} className="accent-phosphor" />
              Skip already synced entries <span className="text-text-muted">(recommended — avoids re-requesting confirmed matches)</span>
            </label>
            <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
              <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} disabled={!!isJobRunning} className="accent-phosphor" />
              Only entries with no mapping data yet
            </label>
            <label className="flex items-center gap-2 text-xs cursor-pointer pt-1 border-t border-border/50 mt-1">
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} disabled={!!isJobRunning} className="accent-status-rejected" />
              <span className={overwrite ? 'text-status-rejected' : 'text-text-secondary'}>
                Overwrite existing mappings <span className="text-text-muted">(replaces whatever's already stored with Hasheous's current answer — including clearing a field entirely if Hasheous doesn't have a match for it. Leave unchecked to only fill in what's currently missing.)</span>
              </span>
            </label>
            <div className="flex items-center gap-2">
              <label className="text-xs text-text-muted shrink-0 w-20">Max entries</label>
              <input type="number" min={1} max={10000} value={pullLimit} disabled={!!isJobRunning}
                onChange={(e) => setPullLimit(Math.max(1, parseInt(e.target.value) || 500))}
                className="w-20 px-2 py-1 rounded border border-border bg-bg-base text-xs text-text-primary disabled:opacity-50" />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-text-muted shrink-0 w-20">Delay (ms)</label>
              <input type="number" min={0} max={5000} value={delayMs} disabled={!!isJobRunning}
                onChange={(e) => setDelayMs(Math.max(0, parseInt(e.target.value) || 400))}
                className="w-20 px-2 py-1 rounded border border-border bg-bg-base text-xs text-text-primary disabled:opacity-50" />
              <span className="text-[10px] text-text-muted">{pullLimit} entries ≈ {Math.round(pullLimit * delayMs / 60000)}m</span>
            </div>
          </div>
          <button disabled={!!isJobRunning || resuming} onClick={startPull}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-phosphor/10 border border-phosphor/30 text-phosphor text-sm font-medium hover:bg-phosphor/20 transition-colors disabled:opacity-50">
            {isJobRunning ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
            {isJobRunning ? 'Running…' : resuming ? 'Checking for active job…' : 'Pull from Hasheous'}
          </button>
          {pullError && <p className="text-xs text-status-rejected mt-2">{pullError}</p>}
        </div>
      </div>

      {activeJob && (
        <div className="p-5 rounded-lg border border-border bg-bg-surface space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              {activeJob.status === 'running' && <RefreshCw size={14} className="text-phosphor animate-spin" />}
              {activeJob.status === 'done' && <CheckCircle2 size={14} className="text-status-approved" />}
              {activeJob.status === 'error' && <XCircle size={14} className="text-status-rejected" />}
              <span className="text-sm font-medium text-text-primary">
                {activeJob.status === 'running' ? 'Pulling…' : activeJob.status === 'done' ? 'Complete' : activeJob.status === 'error' ? 'Error' : 'Starting…'}
              </span>
              <span className="text-xs text-text-muted font-mono">{activeJob.env}</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Clock size={11} />
                {elapsed(activeJob.startedAt, activeJob.finishedAt)}
                {eta !== null && activeJob.status === 'running' && ` · ~${eta}s left`}
              </div>
              <a href={`/api/admin/hasheous/pull/log?id=${activeJob.id}`}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-border text-text-muted hover:border-phosphor/40 hover:text-phosphor transition-colors">
                <FileDown size={11} /> Download full log (.txt)
              </a>
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex justify-between text-xs text-text-muted font-mono">
              <span>{activeJob.processed} / {activeJob.total}</span>
              <span>{pct}%</span>
            </div>
            <div className="h-2 bg-bg-elevated rounded-full overflow-hidden">
              <div className="h-full bg-phosphor rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 text-center">
            <button onClick={() => setResultsTab('updated')}
              className={`p-2 rounded transition-colors ${resultsTab === 'updated' ? 'bg-phosphor/15 ring-1 ring-phosphor/40' : 'bg-bg-elevated hover:bg-bg-hover'}`}>
              <p className="text-lg font-bold text-phosphor">{activeJob.updated}</p>
              <p className="text-[10px] text-text-muted uppercase tracking-wider">Updated</p>
            </button>
            <button onClick={() => setResultsTab('found')}
              className={`p-2 rounded transition-colors ${resultsTab === 'found' ? 'bg-status-approved-bg ring-1 ring-status-approved/40' : 'bg-bg-elevated hover:bg-bg-hover'}`}>
              <p className="text-lg font-bold text-status-approved">{activeJob.found - activeJob.updated}</p>
              <p className="text-[10px] text-text-muted uppercase tracking-wider">Found, no new data</p>
            </button>
            <button onClick={() => setResultsTab('notfound')}
              className={`p-2 rounded transition-colors ${resultsTab === 'notfound' ? 'bg-status-rejected-bg ring-1 ring-status-rejected/40' : 'bg-bg-elevated hover:bg-bg-hover'}`}>
              <p className="text-lg font-bold text-text-muted">{activeJob.notFound}</p>
              <p className="text-[10px] text-text-muted uppercase tracking-wider">Not found</p>
            </button>
          </div>

          {activeList.length > 0 && (
            <div className="border border-border rounded-lg max-h-72 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-bg-elevated sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-text-muted">Entry</th>
                    {resultsTab === 'updated' && <th className="text-left px-3 py-2 font-medium text-text-muted">Fields</th>}
                    <th className="text-left px-3 py-2 font-medium text-text-muted">SHA1</th>
                  </tr>
                </thead>
                <tbody>
                  {activeList.slice(0, 300).map((r) => (
                    <tr key={r.id} className="border-t border-border-subtle">
                      <td className="px-3 py-1.5 text-text-primary">{r.hackName}</td>
                      {resultsTab === 'updated' && <td className="px-3 py-1.5 text-text-muted">{r.mappingsApplied?.join(', ')}</td>}
                      <td className="px-3 py-1.5 text-text-muted font-mono">{r.sha1.slice(0, 12)}…</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {activeList.length > 300 && (
                <p className="text-xs text-text-muted text-center py-2 border-t border-border-subtle">
                  Showing first 300 of {activeList.length} — download the full log to see all.
                </p>
              )}
            </div>
          )}
          {activeList.length === 0 && activeJob.processed > 0 && (
            <p className="text-xs text-text-muted text-center py-4">Nothing in this category yet.</p>
          )}
        </div>
      )}

      <div className="flex items-center gap-4">
        <a href={ENV_URLS[env]} target="_blank" rel="noreferrer" className="text-xs text-phosphor hover:underline flex items-center gap-1">
          <ExternalLink size={11} /> Open Hasheous ({env})
        </a>
        <Link href="/admin/hasheous/history" className="text-xs text-phosphor hover:underline flex items-center gap-1">
          <History size={11} /> View sync history
        </Link>
      </div>
    </div>
  );
}
