// src/components/PatchOrganizeButton.tsx
'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { FolderTree, Eye, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';

interface OrganizeProblem {
  id: string;
  hackName: string;
  version: string;
  kind: string;
  detail: string;
  from: string;
  to: string | null;
}

interface OrganizeMove {
  id: string;
  hackName: string;
  version: string;
  from: string;
  to: string;
}

interface OrganizeResult {
  dryRun: boolean;
  checked: number;
  alreadyOrganized: number;
  pending: number;
  moved: number;
  remaining: number;
  problems: OrganizeProblem[];
  preview: OrganizeMove[];
}

const PROBLEM_LABELS: Record<string, string> = {
  'source-missing': 'File not on disk',
  'destination-exists': 'Something already at the destination',
  inconclusive: "Couldn't confirm",
  'invalid-path': 'Invalid stored location',
  'no-patch-identity': 'No patch hash/type recorded',
  'changed-during-run': 'Changed while organizing',
};

// A real run is capped per request (so no single request runs long); keep going
// until the server says nothing is left, or a pass makes no progress at all.
const MAX_PASSES = 200;

export function PatchOrganizeButton() {
  const [busy, setBusy] = useState<'preview' | 'run' | null>(null);
  const [result, setResult] = useState<OrganizeResult | null>(null);
  const [movedSoFar, setMovedSoFar] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function call(dryRun: boolean): Promise<OrganizeResult> {
    const res = await fetch('/api/admin/patches/organize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Organizing patch files failed.');
    return data as OrganizeResult;
  }

  async function preview() {
    setBusy('preview');
    setError(null);
    setResult(null);
    setMovedSoFar(0);
    try {
      setResult(await call(true));
    } catch (err: any) {
      setError(err?.message || 'Preview failed.');
    } finally {
      setBusy(null);
    }
  }

  async function run() {
    setBusy('run');
    setError(null);
    setResult(null);
    setMovedSoFar(0);
    let total = 0;
    try {
      let last: OrganizeResult | null = null;
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        last = await call(false);
        total += last.moved;
        setMovedSoFar(total);
        setResult(last);
        if (last.remaining === 0 || last.moved === 0) break;
      }
    } catch (err: any) {
      setError(`${err?.message || 'Organizing failed.'}${total > 0 ? ` (${total} moved before it stopped — safe to run again.)` : ''}`);
    } finally {
      setBusy(null);
    }
  }

  const finishedRun = result && !result.dryRun && !busy;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" loading={busy === 'preview'} disabled={busy !== null} onClick={preview}>
          <Eye size={14} className="mr-1.5" /> Preview
        </Button>
        <Button variant="secondary" size="sm" loading={busy === 'run'} disabled={busy !== null} onClick={run}>
          <FolderTree size={14} className="mr-1.5" /> Organize now
        </Button>
      </div>

      {busy === 'run' && (
        <p className="text-xs text-text-secondary">
          Working… <span className="font-mono text-text-primary">{movedSoFar}</span> moved so far. Leave this page open.
        </p>
      )}

      {result && (
        <div className="space-y-3">
          <div className="flex items-start gap-2 text-sm text-status-approved">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
            <p className="text-text-secondary">
              Looked at <span className="text-text-primary font-medium">{result.checked}</span> uploaded patch
              file{result.checked === 1 ? '' : 's'}.{' '}
              <span className="text-text-primary font-medium">{result.alreadyOrganized}</span> already in the right
              folder.{' '}
              {result.dryRun ? (
                <>
                  <span className="text-text-primary font-medium">{result.pending}</span> would be moved
                  {result.problems.length > 0 ? ` (${result.problems.length} more can't be, see below)` : ''}. Nothing has
                  been changed.
                </>
              ) : (
                <>
                  <span className="text-text-primary font-medium">{movedSoFar}</span> moved
                  {busy ? ' so far' : ''}
                  {finishedRun && result.remaining > 0 ? `, ${result.remaining} still to go — run it again` : ''}.
                </>
              )}
            </p>
          </div>

          {result.preview.length > 0 && (
            <div className="border border-border rounded-md overflow-hidden">
              <div className="px-3 py-2 bg-bg-elevated text-xs font-medium text-text-secondary uppercase tracking-wide">
                {result.dryRun ? 'Would move' : 'Moved'}
                {result.preview.length < (result.dryRun ? result.pending : result.moved) ? ` (first ${result.preview.length})` : ''}
              </div>
              <div className="divide-y divide-border max-h-80 overflow-y-auto">
                {result.preview.map((m) => (
                  <div key={m.id} className="px-3 py-2 text-xs space-y-0.5">
                    <div className="text-text-primary">
                      {m.hackName} — {m.version}
                    </div>
                    <div className="font-mono text-text-secondary break-all">{m.from}</div>
                    <div className="font-mono text-phosphor break-all">→ {m.to}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {result.problems.length > 0 && (
            <div className="border border-border rounded-md overflow-hidden">
              <div className="px-3 py-2 bg-bg-elevated text-xs font-medium text-text-secondary uppercase tracking-wide flex items-center gap-1.5">
                <AlertTriangle size={12} /> {result.problems.length} left alone
              </div>
              <div className="divide-y divide-border max-h-80 overflow-y-auto">
                {result.problems.map((p, i) => (
                  <div key={`${p.id}-${i}`} className="px-3 py-2 text-xs space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-status-pending font-medium">{PROBLEM_LABELS[p.kind] ?? p.kind}</span>
                      <span className="text-text-primary">
                        {p.hackName} — {p.version}
                      </span>
                    </div>
                    <div className="text-text-secondary">{p.detail}</div>
                    <div className="font-mono text-text-secondary break-all">{p.from}</div>
                    {p.to && <div className="font-mono text-text-secondary break-all">→ {p.to}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="flex items-center gap-1.5 text-sm text-status-rejected">
          <XCircle size={14} /> {error}
        </p>
      )}
    </div>
  );
}
