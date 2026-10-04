'use client';

// src/components/bulk/BulkRowCard.tsx
//
// One version in the bulk-submit table. A stacked card rather than a table
// row so it reads on a phone; purely presentational — every change is handed
// back to BulkSubmitForm, which owns the state. Issues are passed in already
// computed (bulkRowState.computeRowIssues), so what this shows and what
// blocks sending can't disagree.
import React from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Loader2, X, XCircle, FileCheck2, FileQuestion } from 'lucide-react';
import { formatBytes } from '../ROMProcessor';
import { patchTypeLabel } from '@/lib/patchTypes';
import { Field, inputClass } from './ui';
import type { BulkRow, PatchEntry, RowIssues } from '@/lib/bulkRowState';

interface Props {
  row: BulkRow;
  issues: RowIssues;
  /** True when this row has warnings the person hasn't ticked yet. */
  needsAck: boolean;
  patches: PatchEntry[];
  /** Whether a base ROM is available to check patches against. */
  canVerify: boolean;
  defaultSourceUrl: string;
  /** Locked while a send is in progress. */
  locked: boolean;
  onChange: (changes: Partial<BulkRow>) => void;
  onPatchChange: (patchKey: string | null) => void;
  onAck: () => void;
  onRemove: () => void;
}

function StatusBadge({ row }: { row: BulkRow }) {
  if (row.phase === 'hashing') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-text-muted">
        <Loader2 size={12} className="animate-spin" /> Reading {Math.round(row.hashProgress)}%
      </span>
    );
  }
  if (row.phase === 'sending') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-text-muted">
        <Loader2 size={12} className="animate-spin" /> Submitting…
      </span>
    );
  }
  if (row.phase === 'created') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-phosphor">
        <CheckCircle2 size={12} /> Submitted
      </span>
    );
  }
  if (row.phase === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-status-rejected">
        <XCircle size={12} /> Not submitted
      </span>
    );
  }
  return null;
}

export function BulkRowCard({ row, issues, needsAck, patches, canVerify, defaultSourceUrl, locked, onChange, onPatchChange, onAck, onRemove }: Props) {
  const done = row.phase === 'created';
  const fieldsLocked = locked || done || row.phase === 'sending';
  const patch = patches.find((p) => p.key === row.patchKey) ?? null;
  const v = row.verify;

  return (
    <div
      className={[
        'rounded-lg border p-4 space-y-3',
        done ? 'border-phosphor/40 bg-phosphor/5' : issues.errors.length ? 'border-status-rejected/40 bg-bg-surface' : 'border-border bg-bg-surface',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary truncate" title={row.filename}>{row.filename}</p>
          <p className="text-xs text-text-muted mt-0.5 flex items-center gap-2 flex-wrap">
            <span>{formatBytes(row.fileSize)}</span>
            {row.hash && <span className="font-mono" title={`SHA-1 ${row.hash.sha1}`}>{row.hash.sha1.slice(0, 8)}…</span>}
            <StatusBadge row={row} />
          </p>
        </div>
        <button
          type="button"
          onClick={onRemove}
          disabled={fieldsLocked}
          aria-label={`Remove ${row.filename}`}
          className="shrink-0 p-1 rounded text-text-muted hover:text-status-rejected hover:bg-bg-elevated disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor/40"
        >
          <X size={16} />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Version" required>
          <input
            className={inputClass}
            value={row.version}
            disabled={fieldsLocked}
            maxLength={50}
            placeholder="e.g. 1.2"
            onChange={(e) => onChange({ version: e.target.value, versionAuto: false })}
          />
          {row.versionAuto && row.version && (
            <p className="text-[11px] text-phosphor/80 mt-1">Taken from the file name — check it.</p>
          )}
        </Field>
        <Field label="Release date">
          <input
            type="date"
            className={inputClass}
            value={row.releaseDate}
            disabled={fieldsLocked}
            onChange={(e) => onChange({ releaseDate: e.target.value })}
          />
        </Field>
        <Field label="Source URL">
          <input
            className={inputClass}
            value={row.sourceUrl}
            disabled={fieldsLocked}
            placeholder={defaultSourceUrl || 'https://…'}
            onChange={(e) => onChange({ sourceUrl: e.target.value })}
          />
        </Field>
      </div>

      <Field label="What changed in this version">
        <textarea
          className={`${inputClass} resize-y`}
          rows={2}
          value={row.changelog}
          disabled={fieldsLocked}
          maxLength={3000}
          placeholder="Optional — a short changelog for this version"
          onChange={(e) => onChange({ changelog: e.target.value })}
        />
      </Field>

      {(patches.length > 0 || row.patchKey) && (
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-text-primary" htmlFor={`patch-${row.key}`}>Patch</label>
          <select
            id={`patch-${row.key}`}
            className={inputClass}
            value={row.patchKey ?? ''}
            disabled={fieldsLocked || row.patchPhase === 'uploaded'}
            onChange={(e) => onPatchChange(e.target.value || null)}
          >
            <option value="">No patch for this version</option>
            {patches.map((p) => (
              <option key={p.key} value={p.key}>
                {p.filename}{p.patchType ? ` (${patchTypeLabel(p.patchType)})` : ''}
              </option>
            ))}
          </select>
          {patch && (
            <p className="text-xs flex items-center gap-1.5 flex-wrap">
              {v === 'running' ? (
                <span className="inline-flex items-center gap-1 text-text-muted"><Loader2 size={12} className="animate-spin" /> Checking against the base ROM…</span>
              ) : v && v.state === 'verified' ? (
                <span className="inline-flex items-center gap-1 text-phosphor"><FileCheck2 size={12} /> Verified: applying this patch to the base ROM gives exactly this ROM.</span>
              ) : v ? (
                <span className="inline-flex items-center gap-1 text-text-muted"><FileQuestion size={12} /> {v.state === 'unsupported' ? "Couldn't be checked in the browser (format not supported)." : 'Check did not confirm this pairing.'}</span>
              ) : canVerify ? (
                <span className="text-text-muted">Not checked yet.</span>
              ) : (
                <span className="text-text-muted">
                  {row.patchConfidence === 'exact' ? 'Matched by file name. ' : row.patchConfidence === 'version' ? 'Matched by version number. ' : ''}
                  Add the base ROM file above to verify this.
                </span>
              )}
            </p>
          )}
          {row.patchPhase === 'uploading' && <p className="text-xs text-text-muted inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> Uploading patch…</p>}
          {row.patchPhase === 'uploaded' && <p className="text-xs text-phosphor inline-flex items-center gap-1"><CheckCircle2 size={12} /> Patch uploaded.</p>}
        </div>
      )}

      {issues.errors.length > 0 && !done && (
        <ul className="space-y-1" aria-label="Problems with this version">
          {issues.errors.map((e, i) => (
            <li key={i} className="text-xs text-status-rejected flex items-start gap-1.5"><XCircle size={12} className="shrink-0 mt-0.5" /> {e}</li>
          ))}
        </ul>
      )}

      {issues.warnings.length > 0 && !done && (
        <div className="rounded-md border border-status-pending/30 bg-status-pending/5 p-2.5 space-y-1.5">
          <ul className="space-y-1" aria-label="Things to check on this version">
            {issues.warnings.map((w) => (
              <li key={w.id} className="text-xs text-status-pending flex items-start gap-1.5">
                <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                <span>
                  {w.text}{' '}
                  {w.href && <Link href={w.href} target="_blank" className="underline hover:text-text-primary">View</Link>}
                </span>
              </li>
            ))}
          </ul>
          <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
            <input type="checkbox" checked={!needsAck} disabled={fieldsLocked} onChange={onAck} className="accent-phosphor" />
            I&apos;ve checked this and want to submit it anyway
          </label>
        </div>
      )}

      {row.phase === 'failed' && row.error && (
        <p className="text-xs text-status-rejected flex items-start gap-1.5" role="alert"><XCircle size={12} className="shrink-0 mt-0.5" /> {row.error}</p>
      )}
      {row.patchPhase === 'failed' && row.patchError && row.submissionId && (
        <p className="text-xs text-status-pending flex items-start gap-1.5" role="alert">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          <span>
            The version was submitted, but its patch didn&apos;t upload: {row.patchError}{' '}
            <Link href={`/submissions/${row.submissionId}`} target="_blank" className="underline hover:text-text-primary">Open it to attach the patch there</Link>.
          </span>
        </p>
      )}
      {done && row.submissionId && (
        <Link href={`/submissions/${row.submissionId}`} target="_blank" className="text-xs text-phosphor hover:underline">View this version</Link>
      )}
    </div>
  );
}
