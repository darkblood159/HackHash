'use client';

// src/components/ImportDatForm.tsx
import React, { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from './ui/Button';
import { Upload, FileWarning, CheckCircle2, AlertTriangle, Loader2, Sparkles } from 'lucide-react';
import { PLATFORMS, PLATFORM_LABELS } from '@/types';
import { parseDatFile, validateEntries, extractDismissedDuplicates, type ValidatedEntry } from '@/lib/dat-parser';

const inputClass = "w-full px-3 py-2 rounded-md bg-bg-surface border border-border text-text-primary text-sm placeholder:text-text-muted focus:border-phosphor/50";

interface SkippedDuplicate {
  machineName: string;
  sha1: string;
  existingSubmissionId?: string;
  existingHackName?: string;
  existingStatus?: string;
}

interface ImportResult {
  imported: number;
  skippedDuplicates: number;
  errors: Array<{ machineName: string; error: string }>;
  dismissalsRestored?: number;
  // AUG-28: the backend has always saved this level of detail to the
  // DatImport row's skippedLog — it just never made it into the response
  // this component receives, so there was previously no way to show it no
  // matter what this file did. Only ever contains the actual SHA-1
  // duplicates (skippedDuplicates' matching entries), not every possible
  // skip reason — invalid-size etc. skips still only ever show up in the
  // aggregate count, same as before, since those aren't really actionable
  // the way "here's exactly what this collided with" is.
  duplicateDetails: SkippedDuplicate[];
}

// Sent in batches rather than one giant request — a single request with
// thousands of entries can exceed a reverse proxy's default body-size limit
// (commonly 1MB), which surfaces to the browser as a generic network error
// with no useful detail. Batching avoids that regardless of proxy config.
const UPLOAD_BATCH_SIZE = 200;

export function ImportDatForm() {
  const router = useRouter();
  const [platform, setPlatform] = useState('');
  const [note, setNote] = useState('');
  const [filename, setFilename] = useState<string | null>(null);
  const [fileSizeBytes, setFileSizeBytes] = useState<number | undefined>(undefined);
  const [entries, setEntries] = useState<ValidatedEntry[] | null>(null);
  const [rawText, setRawText] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const handleFile = useCallback((file: File) => {
    setParseError(null);
    setResult(null);
    setFilename(file.name);
    setFileSizeBytes(file.size);

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = reader.result as string;
        const parsed = parseDatFile(file.name, text);
        setEntries(validateEntries(parsed));
        setRawText(text);
      } catch (err) {
        setEntries(null);
        setRawText(null);
        setParseError(err instanceof Error ? err.message : 'Could not parse this file.');
      }
    };
    reader.onerror = () => setParseError('Could not read this file.');
    reader.readAsText(file);
  }, []);

  const validCount = entries?.filter((e) => e.valid).length ?? 0;
  const invalidCount = (entries?.length ?? 0) - validCount;
  // Rich fields only ever come from re-importing our own "detailed" export
  // (see src/lib/dat-parser.ts) — a plain DAT XML or lean JSON never has these.
  const detailedCount = entries?.filter((e) =>
    e.author || e.versionChangelog || e.translationLanguages?.length || e.realDescription || e.tags?.length || e.sourceUrl || e.notes || e.gameDatabaseLinks
  ).length ?? 0;

  const runImport = async () => {
    if (!entries || !platform) return;
    setImporting(true);
    setResult(null);
    setParseError(null);

    const validEntries = entries.filter((e) => e.valid);
    const batches: ValidatedEntry[][] = [];
    for (let i = 0; i < validEntries.length; i += UPLOAD_BATCH_SIZE) {
      batches.push(validEntries.slice(i, i + UPLOAD_BATCH_SIZE));
    }

    const aggregate: ImportResult = { imported: 0, skippedDuplicates: 0, errors: [], duplicateDetails: [] };
    setProgress({ done: 0, total: batches.length });
    let importId: string | undefined;

    for (let i = 0; i < batches.length; i++) {
      try {
        const res = await fetch('/api/admin/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            importId,
            platform,
            note: note || undefined,
            sourceFilename: filename,
            sourceFileSizeBytes: i === 0 ? fileSizeBytes : undefined,
            totalParsed: i === 0 ? entries.length : undefined,
            entries: batches[i],
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          aggregate.errors.push({
            machineName: `Batch ${i + 1} of ${batches.length}`,
            error: data.error ?? `Request failed (HTTP ${res.status})`,
          });
        } else {
          importId = data.importId ?? importId;
          aggregate.imported += data.imported ?? 0;
          aggregate.skippedDuplicates += data.skippedDuplicates ?? 0;
          aggregate.errors.push(...(data.errors ?? []));
          aggregate.duplicateDetails.push(
            ...((data.skippedEntries ?? []) as Array<{ machineName: string; sha1: string; reason: string; existingSubmissionId?: string; existingHackName?: string; existingStatus?: string }>)
              .filter((e) => e.reason === 'Duplicate — SHA-1 already exists')
          );
        }
      } catch {
        aggregate.errors.push({
          machineName: `Batch ${i + 1} of ${batches.length}`,
          error: 'Network error — this batch may not have gone through. If this keeps happening, your reverse proxy may be capping request size.',
        });
      }

      setProgress({ done: i + 1, total: batches.length });
    }

    // Families now exist from the entries just imported, so this has to run
    // after the loop above, not alongside it — a pair naming two families
    // can't resolve to anything until both actually exist. No-op if this
    // wasn't a detailed export or it had no dismissals recorded.
    if (rawText && filename) {
      const pairs = extractDismissedDuplicates(filename, rawText);
      if (pairs.length > 0) {
        try {
          const res = await fetch('/api/admin/hack-families/import-dismissals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pairs }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok) aggregate.dismissalsRestored = data.restored ?? 0;
        } catch {
          // Non-fatal — the entries themselves already imported successfully
          // above; losing the dismissal restore shouldn't look like the
          // whole import failed.
        }
      }
    }

    setResult(aggregate);
    setImporting(false);
    router.refresh();
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="grid sm:grid-cols-2 gap-5">
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">
            Platform <span className="text-phosphor">*</span>
          </label>
          <select className={inputClass} value={platform} onChange={(e) => setPlatform(e.target.value)}>
            <option value="" disabled>Select a platform…</option>
            {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>)}
          </select>
          <p className="text-xs text-text-muted mt-1">Applied to every entry in this file.</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">Note (optional)</label>
          <input
            className={inputClass}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Imported from my-old-romhacks-2023.dat"
          />
        </div>
      </div>

      <div
        onClick={() => document.getElementById('dat-file-input')?.click()}
        className="border-2 border-dashed border-border rounded-xl p-8 text-center cursor-pointer hover:border-phosphor/50 hover:bg-bg-elevated transition-colors"
      >
        <Upload size={22} className="text-text-muted mx-auto mb-2" />
        <p className="text-sm text-text-primary">{filename ?? 'Select a .dat, .xml, or .json file'}</p>
        <p className="text-xs text-text-muted mt-1">Parsed entirely in your browser — only the resulting metadata is sent.</p>
        <input
          id="dat-file-input"
          type="file"
          accept=".dat,.xml,.json"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
        />
      </div>

      {parseError && (
        <div className="p-3 rounded-lg bg-status-rejected-bg border border-status-rejected/30 flex items-start gap-2">
          <AlertTriangle size={14} className="text-status-rejected shrink-0 mt-0.5" />
          <p className="text-sm text-status-rejected">{parseError}</p>
        </div>
      )}

      {entries && (
        <div className="space-y-4">
          <div className="flex items-center gap-4 text-sm">
            <span className="text-status-approved flex items-center gap-1.5">
              <CheckCircle2 size={14} /> {validCount} ready to import
            </span>
            {invalidCount > 0 && (
              <span className="text-status-pending flex items-center gap-1.5">
                <FileWarning size={14} /> {invalidCount} will be skipped (incomplete data)
              </span>
            )}
            {detailedCount > 0 && (
              <span className="text-phosphor flex items-center gap-1.5">
                <Sparkles size={14} /> {detailedCount} include extra detail (author, tags, links, etc.) — will be imported too
              </span>
            )}
          </div>

          <div className="border border-border rounded-lg max-h-80 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-bg-elevated text-text-muted uppercase tracking-wider sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Name</th>
                  <th className="text-left px-3 py-2 font-medium hidden sm:table-cell">Version</th>
                  <th className="text-left px-3 py-2 font-medium font-mono hidden md:table-cell">SHA1</th>
                  <th className="text-left px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {entries.slice(0, 500).map((e, i) => (
                  <tr key={i} className="border-t border-border-subtle">
                    <td className="px-3 py-1.5 text-text-primary truncate max-w-[200px]">{e.hackName}</td>
                    <td className="px-3 py-1.5 text-text-muted hidden sm:table-cell">{e.version}</td>
                    <td className="px-3 py-1.5 text-text-muted font-mono hidden md:table-cell">{e.sha1 ? `${e.sha1.slice(0, 12)}…` : '—'}</td>
                    <td className="px-3 py-1.5">
                      {e.valid ? (
                        <span className="text-status-approved">Ready</span>
                      ) : (
                        <span className="text-status-pending" title={e.issue}>{e.issue}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {entries.length > 500 && (
              <p className="text-xs text-text-muted text-center py-2 border-t border-border-subtle">
                Showing first 500 of {entries.length} — all valid entries will still be imported.
              </p>
            )}
          </div>

          <Button onClick={runImport} loading={importing} disabled={!platform || validCount === 0}>
            {importing ? 'Importing…' : `Import ${validCount} entries`}
          </Button>
          {!platform && <p className="text-xs text-status-pending">Select a platform above first.</p>}
          {progress && importing && (
            <div className="space-y-1.5">
              <div className="h-1 bg-bg-elevated rounded-full overflow-hidden">
                <div
                  className="h-full bg-phosphor rounded-full transition-all duration-200"
                  style={{ width: `${(progress.done / progress.total) * 100}%` }}
                />
              </div>
              <p className="text-xs text-text-muted font-mono">Batch {progress.done} of {progress.total}</p>
            </div>
          )}
        </div>
      )}

      {result && (
        <div className="p-4 rounded-lg bg-phosphor/5 border border-phosphor/30 space-y-2">
          <p className="text-sm text-phosphor font-medium">Import complete</p>
          <p className="text-sm text-text-secondary">
            {result.imported} entries added to the database
            {result.skippedDuplicates > 0 && `, ${result.skippedDuplicates} skipped (already existed by SHA-1)`}
            {result.errors.length > 0 && `, ${result.errors.length} failed`}.
          </p>
          {!!result.dismissalsRestored && (
            <p className="text-sm text-text-secondary">
              {result.dismissalsRestored} "not a duplicate" decision{result.dismissalsRestored === 1 ? '' : 's'} restored from the file.
            </p>
          )}
          {result.errors.length > 0 && (
            <details className="text-xs text-text-muted">
              <summary className="cursor-pointer">View errors</summary>
              <ul className="mt-2 space-y-1">
                {result.errors.slice(0, 50).map((e, i) => (
                  <li key={i}>{e.machineName}: {e.error}</li>
                ))}
              </ul>
            </details>
          )}
          {result.duplicateDetails.length > 0 && (
            <details className="text-xs text-text-muted">
              <summary className="cursor-pointer">View what the {result.skippedDuplicates} duplicate{result.skippedDuplicates === 1 ? '' : 's'} matched</summary>
              <ul className="mt-2 space-y-1.5">
                {result.duplicateDetails.slice(0, 50).map((d, i) => (
                  <li key={i}>
                    <span className="text-text-secondary">{d.machineName}</span> — same SHA-1 as{' '}
                    {d.existingSubmissionId ? (
                      <a href={`/submissions/${d.existingSubmissionId}`} target="_blank" rel="noreferrer" className="text-phosphor hover:underline">
                        {d.existingHackName ?? 'existing submission'}
                      </a>
                    ) : (
                      <span>an existing submission</span>
                    )}
                    {d.existingStatus && <span className="text-text-muted"> ({d.existingStatus.toLowerCase()})</span>}
                  </li>
                ))}
              </ul>
              {result.duplicateDetails.length > 50 && (
                <p className="mt-1 text-text-muted">…and {result.duplicateDetails.length - 50} more.</p>
              )}
            </details>
          )}
        </div>
      )}
    </div>
  );
}
