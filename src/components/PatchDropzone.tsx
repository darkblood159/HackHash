'use client';

// src/components/PatchDropzone.tsx
//
// Compact drag-and-drop for a single patch file, used inside SubmitForm's
// "Patch details" section to fill in patch type / filename / SHA-1 from the
// actual file instead of typing them by hand.
//
// Deliberately NOT built on ROMProcessor.tsx: that component's multi-file
// state machine and archive-extraction wiring exist for ROMs, which can be
// gigabytes and sometimes arrive zipped. Patches are almost always a few KB
// to a few MB and are never themselves archives here, so this hashes the
// one file directly via the browser's native Web Crypto API instead of
// reusing ROMProcessor's hand-rolled streaming CRC32/MD5/SHA-1 pass (that
// pass exists specifically to avoid re-reading a huge file three times —
// not a concern at patch-file sizes, and SHA-1 is the only hash a patch
// needs here). This also means zero changes to ROMProcessor.tsx or the
// archive-extraction pipeline it shares with three other components — worth
// keeping that way while a separate session is actively working in that
// exact area (see handoff).
import React, { useCallback, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Upload, FileCheck, AlertCircle, Loader2 } from 'lucide-react';
import { patchTypeFromFilename, type PatchTypeValue } from '@/lib/patchTypes';

export interface ParsedPatch {
  patchType: PatchTypeValue | null;
  patchFilename: string;
  patchSha1: string;
}

async function sha1Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function PatchDropzone({ onParsed }: { onParsed: (result: ParsedPatch) => void }) {
  const [dragging, setDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ParsedPatch | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const processFile = useCallback(async (file: File) => {
    setProcessing(true);
    setError(null);
    try {
      const patchSha1 = await sha1Hex(file);
      const patchType = patchTypeFromFilename(file.name);
      const result: ParsedPatch = { patchType, patchFilename: file.name, patchSha1 };
      setLastResult(result);
      onParsed(result);
    } catch {
      setError("Couldn't read that file — please try again, or fill the fields in manually below.");
    } finally {
      setProcessing(false);
    }
  }, [onParsed]);

  // Exactly one patch per submission (one patchFilename field) — if more
  // than one file gets dropped/selected at once, only the first is used and
  // the rest are silently ignored, same "don't guess which one, just take
  // the unambiguous case" spirit as the rest of this form, applied to a
  // situation where there's no real ambiguity to begin with (there's only
  // ever one place for this to go).
  const handleFiles = useCallback((list: FileList | null) => {
    if (!list || list.length === 0) return;
    processFile(list[0]);
  }, [processFile]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  return (
    <div className="space-y-2">
      <div
        onDrop={onDrop}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onClick={() => inputRef.current?.click()}
        className={clsx(
          'relative border-2 border-dashed rounded-lg px-4 py-5 cursor-pointer transition-all',
          'flex items-center justify-center gap-3 text-center select-none',
          dragging ? 'border-phosphor bg-phosphor/5' : 'border-border hover:border-phosphor/50 hover:bg-bg-elevated'
        )}
      >
        {processing ? (
          <Loader2 size={18} className="text-phosphor animate-spin shrink-0" />
        ) : (
          <Upload size={18} className={clsx('shrink-0', dragging ? 'text-phosphor' : 'text-text-muted')} />
        )}
        <div>
          <p className="text-text-primary text-sm font-medium">
            {processing ? 'Reading patch file…' : dragging ? 'Drop to parse' : 'Drop the patch file here, or click to browse'}
          </p>
          <p className="text-text-muted text-xs mt-0.5">
            Fills in type, filename, and SHA-1 below — hashed locally, the file itself is never uploaded
          </p>
        </div>
        <input ref={inputRef} type="file" className="hidden" onChange={(e) => handleFiles(e.target.files)} />
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-status-rejected">
          <AlertCircle size={12} className="shrink-0" />
          {error}
        </div>
      )}

      {lastResult && !processing && !error && (
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <FileCheck size={12} className="text-phosphor shrink-0" />
          {lastResult.patchType ? (
            <span>Parsed <span className="font-mono text-text-primary">{lastResult.patchFilename}</span> as {lastResult.patchType}</span>
          ) : (
            <span>Parsed <span className="font-mono text-text-primary">{lastResult.patchFilename}</span> — couldn't tell the type from its extension, pick it below</span>
          )}
        </div>
      )}
    </div>
  );
}
