'use client';

// src/app/admin/hack-families/page.tsx
import React, { useState, useEffect } from 'react';
import { Layers, RefreshCw, GitMerge } from 'lucide-react';

interface DuplicatePair {
  a: { id: string; name: string; versionCount: number };
  b: { id: string; name: string; versionCount: number };
  platform: string;
  distance: number;
  prefixMatch: boolean;
}

interface Summary {
  totalFamilies: number;
  multiVersionFamilies: number;
  totalGroupedSubmissions: number;
  ungroupedSubmissions: number;
  duplicateCandidates: DuplicatePair[];
}

interface BackfillResult {
  familiesCreated: number;
  submissionsGrouped: number;
  groupsWithMultipleVersions: number;
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="p-3 rounded-lg border border-border bg-bg-surface text-center">
      <p className="text-lg font-bold text-phosphor">{value.toLocaleString()}</p>
      <p className="text-[10px] text-text-muted uppercase tracking-wider">{label}</p>
    </div>
  );
}

export default function AdminHackFamiliesPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<BackfillResult | null>(null);
  const [mergingPairKey, setMergingPairKey] = useState<string | null>(null);
  const [mergeSuccess, setMergeSuccess] = useState<string | null>(null);

  const loadSummary = () => {
    setLoading(true);
    setError(null);
    fetch('/api/admin/hack-families')
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then(setSummary)
      .catch(() => setError('Failed to load hack families'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadSummary(); }, []);

  const runBackfill = async () => {
    setBackfilling(true);
    setBackfillResult(null);
    setError(null);
    try {
      const res = await fetch('/api/admin/hack-families/backfill', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Backfill failed'); return; }
      setBackfillResult(data);
      loadSummary();
    } catch {
      setError('Network error running backfill');
    } finally {
      setBackfilling(false);
    }
  };

  const merge = async (fromFamilyId: string, intoFamilyId: string, pairKey: string) => {
    setMergingPairKey(pairKey);
    setError(null);
    setMergeSuccess(null);
    try {
      const res = await fetch('/api/admin/hack-families/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromFamilyId, intoFamilyId }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Merge failed'); return; }
      setMergeSuccess(`Merged — moved ${data.movedCount} submission${data.movedCount === 1 ? '' : 's'} into "${data.intoFamilyName}".`);
      loadSummary();
    } catch {
      setError('Network error merging');
    } finally {
      setMergingPairKey(null);
    }
  };

  const dismiss = async (familyAId: string, familyBId: string, pairKey: string) => {
    setMergingPairKey(pairKey);
    setError(null);
    setMergeSuccess(null);
    try {
      const res = await fetch('/api/admin/hack-families/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ familyAId, familyBId }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Dismiss failed'); return; }
      setMergeSuccess('Marked as not a duplicate — won\'t be suggested again.');
      loadSummary();
    } catch {
      setError('Network error dismissing');
    } finally {
      setMergingPairKey(null);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl font-bold">Hack families</h1>
        <p className="text-text-secondary text-sm mt-1 max-w-2xl">
          Groups different versions of the same hack together so they browse as one entry with a version switcher, and
          keeps their shared details in sync. New submissions get grouped automatically — this page is for grouping
          anything that predates the feature, and for cleaning up cases the automatic name-matching didn't catch.
        </p>
      </div>

      {error && <p className="text-sm text-status-rejected">{error}</p>}
      {mergeSuccess && (
        <p className="text-sm text-phosphor bg-phosphor/5 border border-phosphor/20 rounded-lg px-3 py-2">{mergeSuccess}</p>
      )}
      {loading && <p className="text-sm text-text-muted">Loading…</p>}

      {summary && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Families" value={summary.totalFamilies} />
            <StatCard label="With multiple versions" value={summary.multiVersionFamilies} />
            <StatCard label="Grouped submissions" value={summary.totalGroupedSubmissions} />
            <StatCard label="Not yet grouped" value={summary.ungroupedSubmissions} />
          </div>

          <div className="p-5 rounded-lg border border-border bg-bg-surface">
            <div className="flex items-center gap-2 mb-2">
              <Layers size={16} className="text-phosphor" />
              <h2 className="text-sm font-semibold text-text-primary">Group ungrouped submissions</h2>
            </div>
            <p className="text-xs text-text-muted mb-3">
              Safe to run any time — only touches submissions with no family yet. Doesn't change any submission's own
              name, author, release date, description, or tags; it only connects matching ones together.
            </p>
            <button
              disabled={backfilling || summary.ungroupedSubmissions === 0}
              onClick={runBackfill}
              className="flex items-center gap-2 px-4 py-2 rounded-md bg-phosphor/10 border border-phosphor/30 text-phosphor text-sm font-medium hover:bg-phosphor/20 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={14} className={backfilling ? 'animate-spin' : ''} />
              {backfilling
                ? 'Grouping…'
                : summary.ungroupedSubmissions === 0
                ? 'Everything is already grouped'
                : `Group ${summary.ungroupedSubmissions} ungrouped submission${summary.ungroupedSubmissions === 1 ? '' : 's'}`}
            </button>
            {backfillResult && (
              <p className="text-sm text-text-primary mt-3">
                Created {backfillResult.familiesCreated} new famil{backfillResult.familiesCreated === 1 ? 'y' : 'ies'}, grouped{' '}
                {backfillResult.submissionsGrouped} submission{backfillResult.submissionsGrouped === 1 ? '' : 's'}
                {backfillResult.groupsWithMultipleVersions > 0 && <> — {backfillResult.groupsWithMultipleVersions} of those have more than one version</>}.
              </p>
            )}
          </div>

          <div className="p-5 rounded-lg border border-border bg-bg-surface">
            <div className="flex items-center gap-2 mb-1">
              <GitMerge size={16} className="text-phosphor" />
              <h2 className="text-sm font-semibold text-text-primary">Possible duplicate families</h2>
            </div>
            <p className="text-xs text-text-muted mb-4">
              Same-platform families with names close enough that they're probably the same hack — often an edition or
              variant typed into the name itself (e.g. "Hack Name" and "Hack Name (Something Edition)") rather than
              the version field. Review and merge the ones that are actually the same hack; leave the rest.
            </p>

            {summary.duplicateCandidates.length === 0 && (
              <p className="text-sm text-text-muted">None found.</p>
            )}

            <div className="space-y-2 max-h-[32rem] overflow-y-auto">
              {summary.duplicateCandidates.map((pair) => {
                const pairKey = `${pair.a.id}:${pair.b.id}`;
                const isMerging = mergingPairKey === pairKey;
                return (
                  <div
                    key={pairKey}
                    className="p-3 rounded-lg border border-border-subtle bg-bg-base flex items-center justify-between gap-3 flex-wrap"
                  >
                    <div className="flex items-center gap-2 flex-wrap text-sm">
                      <span className="text-text-primary font-medium">{pair.a.name}</span>
                      <span className="text-text-muted text-xs">
                        ({pair.a.versionCount} version{pair.a.versionCount === 1 ? '' : 's'})
                      </span>
                      <span className="text-text-muted">↔</span>
                      <span className="text-text-primary font-medium">{pair.b.name}</span>
                      <span className="text-text-muted text-xs">
                        ({pair.b.versionCount} version{pair.b.versionCount === 1 ? '' : 's'})
                      </span>
                      <span className="text-[10px] text-text-muted uppercase tracking-wider px-1.5 py-0.5 rounded bg-bg-elevated">
                        {pair.platform}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        disabled={isMerging}
                        onClick={() => merge(pair.b.id, pair.a.id, pairKey)}
                        className="px-2.5 py-1 rounded-md text-xs font-medium border border-border text-text-muted hover:border-phosphor/40 hover:text-phosphor transition-colors disabled:opacity-50"
                      >
                        {isMerging ? '…' : `Merge into "${pair.a.name}"`}
                      </button>
                      <button
                        disabled={isMerging}
                        onClick={() => merge(pair.a.id, pair.b.id, pairKey)}
                        className="px-2.5 py-1 rounded-md text-xs font-medium border border-border text-text-muted hover:border-phosphor/40 hover:text-phosphor transition-colors disabled:opacity-50"
                      >
                        {isMerging ? '…' : `Merge into "${pair.b.name}"`}
                      </button>
                      <button
                        disabled={isMerging}
                        onClick={() => dismiss(pair.a.id, pair.b.id, pairKey)}
                        className="px-2.5 py-1 rounded-md text-xs font-medium border border-border text-text-muted hover:border-status-rejected/40 hover:text-status-rejected transition-colors disabled:opacity-50"
                      >
                        {isMerging ? '…' : 'Not a duplicate'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
