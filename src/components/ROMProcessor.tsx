'use client';

// src/components/ROMProcessor.tsx
import React, { useState, useCallback, useRef } from 'react';
import SparkMD5 from 'spark-md5';
import { Upload, FileCheck, Copy, CheckCheck, AlertCircle, ChevronRight, ListChecks } from 'lucide-react';
import { clsx } from 'clsx';
import type { ROMFileInfo } from '@/types';
import { Button } from './ui/Button';
import {
  classifyArchive, readZipCandidates, readGzipFile, read7zCandidates, pickAutoCandidate,
  type ArchiveCandidate,
} from '@/lib/archiveExtract';

// ─── CRC32 Table ──────────────────────────────────────────────────────────────

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

// ─── Single-pass hash computation ─────────────────────────────────────────────
//
// Reads the file ONCE and feeds each chunk to CRC32, MD5, and SHA-1
// simultaneously. The previous approach ran three separate read loops in
// Promise.all(), which:
//   1. Caused 3× the disk I/O (catastrophic on a 3.5GB file)
//   2. Had three independent progress setters racing each other, causing the
//      progress bar to flicker chaotically between the three algorithms
// One pass → one smooth progress counter → no flickering.

const SHA1_K = [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6];

function sha1Block(H: number[], block: Uint8Array) {
  const W = new Uint32Array(80);
  for (let i = 0; i < 16; i++) {
    W[i] = (block[i * 4] << 24) | (block[i * 4 + 1] << 16) |
            (block[i * 4 + 2] << 8) | block[i * 4 + 3];
  }
  for (let i = 16; i < 80; i++) {
    const x = W[i-3] ^ W[i-8] ^ W[i-14] ^ W[i-16];
    W[i] = (x << 1) | (x >>> 31);
  }
  let [a, b, c, d, e] = H;
  for (let i = 0; i < 80; i++) {
    let f: number, k: number;
    if      (i < 20) { f = (b & c) | (~b & d);           k = SHA1_K[0]; }
    else if (i < 40) { f = b ^ c ^ d;                    k = SHA1_K[1]; }
    else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = SHA1_K[2]; }
    else             { f = b ^ c ^ d;                    k = SHA1_K[3]; }
    const temp = (((a << 5) | (a >>> 27)) + f + e + k + W[i]) >>> 0;
    e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = temp;
  }
  H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
  H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0; H[4] = (H[4] + e) >>> 0;
}

async function computeAllHashes(
  file: File,
  onProgress: (p: number) => void
): Promise<{ crc32: string; md5: string; sha1: string }> {
  const CHUNK = 4 * 1024 * 1024; // 4 MB

  // CRC32 state
  let crc = 0xffffffff;

  // MD5 state (SparkMD5 is streaming-friendly)
  const spark = new SparkMD5.ArrayBuffer();

  // SHA-1 streaming state
  const H = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  let totalLen = BigInt(0);
  let pending = new Uint8Array(0);

  let offset = 0;
  while (offset < file.size) {
    const buf = await file.slice(offset, offset + CHUNK).arrayBuffer();
    const bytes = new Uint8Array(buf);

    // CRC32 — one byte at a time through lookup table
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }

    // MD5 — streaming append
    spark.append(buf);

    // SHA-1 — absorb full 64-byte blocks, hold partial block in `pending`
    totalLen += BigInt(buf.byteLength);
    let combined = new Uint8Array(pending.length + bytes.length);
    combined.set(pending);
    combined.set(bytes, pending.length);
    let pos = 0;
    while (pos + 64 <= combined.length) {
      sha1Block(H, combined.slice(pos, pos + 64));
      pos += 64;
    }
    pending = combined.slice(pos);

    offset += CHUNK;
    // Single, smooth 0–99% progress — reserve 100 for finalization
    onProgress(Math.min((offset / file.size) * 99, 99));
  }

  // Finalize CRC32
  const crc32 = ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0').toLowerCase();

  // Finalize MD5
  const md5 = spark.end();

  // Finalize SHA-1 — pad with 0x80, length in bits as 64-bit big-endian
  const bitLen = totalLen * BigInt(8);
  const padLen = 64 - ((pending.length + 9) % 64 || 64);
  const padded = new Uint8Array(pending.length + 1 + padLen + 8);
  padded.set(pending);
  padded[pending.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Number(bitLen >> BigInt(32)), false);
  dv.setUint32(padded.length - 4, Number(bitLen & BigInt(0xffffffff)), false);
  for (let p = 0; p + 64 <= padded.length; p += 64) sha1Block(H, padded.slice(p, p + 64));
  const sha1 = H.map((h) => h.toString(16).padStart(8, '0')).join('');

  onProgress(100);
  return { crc32, md5, sha1 };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

// ─── Hash display ─────────────────────────────────────────────────────────────

function HashValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="group flex items-start gap-3 py-2 px-3 rounded-md hover:bg-bg-elevated transition-colors">
      <span className="text-text-muted text-xs font-mono uppercase tracking-widest w-10 pt-0.5 shrink-0">{label}</span>
      <span className="font-mono text-sm text-phosphor break-all leading-relaxed">{value}</span>
      <button onClick={handleCopy} className="ml-auto shrink-0 text-text-muted hover:text-text-primary transition-colors opacity-0 group-hover:opacity-100" title="Copy">
        {copied ? <CheckCheck size={14} className="text-phosphor" /> : <Copy size={14} />}
      </button>
    </div>
  );
}

// ─── File card ────────────────────────────────────────────────────────────────

function FileCard({ info, onUse }: { info: ROMFileInfo; onUse?: (info: ROMFileInfo) => void }) {
  return (
    <div className="border border-border rounded-lg overflow-hidden bg-bg-surface">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-bg-elevated">
        <FileCheck size={16} className="text-phosphor shrink-0" />
        <div className="flex-1 min-w-0">
          <span className="font-mono text-sm text-text-primary truncate block">{info.filename}</span>
          {info.sourceArchiveName && (
            <span className="text-[10px] text-text-muted truncate block">extracted from {info.sourceArchiveName}</span>
          )}
        </div>
        <span className="text-xs text-text-muted font-mono shrink-0">{formatBytes(info.fileSize)}</span>
      </div>
      <div className="p-4">
        {info.error && (
          <div className="flex items-center gap-2 text-sm text-status-rejected mb-3">
            <AlertCircle size={14} />
            {info.error}
          </div>
        )}
        {info.processing && (
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-text-muted font-mono">
              <span>
                {info.phase === 'loading' ? 'Loading archive reader…' : info.phase === 'extracting' ? 'Extracting…' : 'Computing hashes…'}
              </span>
              {info.progress !== null && <span>{Math.round(info.progress)}%</span>}
            </div>
            <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden">
              {info.progress === null ? (
                // No real percentage exists for this step (7z/RAR's
                // extraction library has no percent-complete callback at
                // all — see src/lib/archiveExtract.ts) — a pulsing
                // full-width bar rather than a specific position, since
                // any specific width here would just be a made-up number.
                <div className="h-full w-full bg-phosphor/40 rounded-full animate-pulse" />
              ) : (
                <div
                  className="h-full bg-phosphor rounded-full transition-all duration-100"
                  style={{ width: `${info.progress}%` }}
                />
              )}
            </div>
            {info.progress !== null && (
              <p className="text-[10px] text-text-muted">
                {formatBytes(Math.round(info.fileSize * info.progress / 100))} of {formatBytes(info.fileSize)} processed
              </p>
            )}
          </div>
        )}
        {!info.processing && !info.error && (
          <div className="space-y-0.5">
            <HashValue label="CRC" value={info.crc32} />
            <HashValue label="MD5" value={info.md5} />
            <HashValue label="SHA1" value={info.sha1} />
          </div>
        )}
      </div>
      {!info.processing && !info.error && onUse && (
        <div className="px-4 pb-4">
          <button
            onClick={() => onUse(info)}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-phosphor/10 border border-phosphor/30 text-phosphor text-sm font-medium hover:bg-phosphor/20 transition-colors"
          >
            Use in submission form <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Archive candidate picker ──────────────────────────────────────────────
//
// Shown instead of a FileCard when an archive has more than one plausible
// file inside it and archiveExtract.ts couldn't confidently pick one on
// its own (see the auto-pick rules in processFile below) — e.g. a zip
// with two regional ROM variants, or one where nothing matches a known
// ROM extension so it's genuinely ambiguous. Candidates already come
// sorted (likely-ROM matches first, largest first within each group).

interface PendingArchive {
  key: number;
  archiveFile: File;
  candidates: ArchiveCandidate[];
  extract: (path: string, onProgress?: (percent: number | null) => void) => Promise<Uint8Array>;
}

const MAX_CANDIDATES_SHOWN = 50;

function ArchivePickerCard({
  pending,
  onChoose,
  onCancel,
}: {
  pending: PendingArchive;
  onChoose: (candidate: ArchiveCandidate) => void;
  onCancel: () => void;
}) {
  const [selectedPath, setSelectedPath] = useState(pending.candidates[0]?.path ?? '');
  const shown = pending.candidates.slice(0, MAX_CANDIDATES_SHOWN);
  const hiddenCount = pending.candidates.length - shown.length;

  return (
    <div className="border border-phosphor/30 rounded-lg overflow-hidden bg-bg-surface">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-bg-elevated">
        <ListChecks size={16} className="text-phosphor shrink-0" />
        <span className="font-mono text-sm text-text-primary truncate flex-1">{pending.archiveFile.name}</span>
        <span className="text-xs text-text-muted font-mono shrink-0">{pending.candidates.length} files</span>
      </div>
      <div className="p-4 space-y-3">
        <p className="text-xs text-text-secondary">
          This archive has more than one file — pick the one that&apos;s the actual ROM.
        </p>
        <div className="space-y-1 max-h-64 overflow-y-auto">
          {shown.map((c) => (
            <button
              key={c.path}
              type="button"
              onClick={() => setSelectedPath(c.path)}
              className={clsx(
                'w-full flex items-center gap-2 px-3 py-2 rounded-md text-left transition-colors',
                selectedPath === c.path
                  ? 'bg-phosphor/10 border border-phosphor/40'
                  : 'border border-transparent hover:bg-bg-elevated'
              )}
            >
              <span className="truncate flex-1 font-mono text-xs text-text-primary">{c.path}</span>
              {c.looksLikeRom && (
                <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-phosphor/15 text-phosphor">likely ROM</span>
              )}
              <span className="shrink-0 text-[10px] text-text-muted font-mono">{c.size != null ? formatBytes(c.size) : '—'}</span>
            </button>
          ))}
        </div>
        {hiddenCount > 0 && (
          <p className="text-[10px] text-text-muted">+{hiddenCount} more file{hiddenCount === 1 ? '' : 's'} not shown.</p>
        )}
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button
            type="button"
            size="sm"
            disabled={!selectedPath}
            onClick={() => {
              const candidate = pending.candidates.find((c) => c.path === selectedPath);
              if (candidate) onChoose(candidate);
            }}
          >
            Hash this file
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface ROMProcessorProps {
  onFileProcessed?: (info: ROMFileInfo) => void;
  showUseButton?: boolean;
  label?: string;
  hint?: string;
}

// Internal-only — never exposed outside this component. Keys each entry by
// a monotonic id instead of matching on filename+size (what this used
// before archive support existed), since extraction adds real concurrency
// that a name/size match can't safely disambiguate: two archives can
// extract same-named same-sized ROMs, and an archive's own placeholder
// card is later relabeled in place to the ROM it turns out to contain.
interface TrackedFile extends ROMFileInfo {
  _key: number;
}

export function ROMProcessor({
  onFileProcessed,
  showUseButton = true,
  label,
  hint,
}: ROMProcessorProps) {
  const [files, setFiles] = useState<TrackedFile[]>([]);
  const [pendingArchives, setPendingArchives] = useState<PendingArchive[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const keyCounter = useRef(0);
  const archiveKeyCounter = useRef(0);

  // Adds a new "processing" card and returns its key. `phase` defaults to
  // 'hashing' (the direct-upload case); zip/gzip pass 'extracting' so the
  // card reads correctly during the extract step that precedes hashing.
  const beginEntry = useCallback(
    (filename: string, fileSize: number, sourceArchiveName?: string, phase?: 'loading' | 'extracting' | 'hashing') => {
      const key = ++keyCounter.current;
      setFiles((prev) => [
        ...prev,
        { filename, fileSize, crc32: '', md5: '', sha1: '', processing: true, progress: 0, phase: phase ?? 'hashing', sourceArchiveName, _key: key },
      ]);
      return key;
    },
    []
  );

  const updateEntry = useCallback((key: number, patch: Partial<TrackedFile>) => {
    setFiles((prev) => prev.map((f) => (f._key === key ? { ...f, ...patch } : f)));
  }, []);

  // A card with no "processing" phase at all — used for failures that are
  // known synchronously (an unsupported archive extension), so there's
  // nothing to show progress for in the first place.
  const addErrorEntry = useCallback((filename: string, fileSize: number, error: string) => {
    const key = ++keyCounter.current;
    setFiles((prev) => [...prev, { filename, fileSize, crc32: '', md5: '', sha1: '', processing: false, progress: 0, error, _key: key }]);
  }, []);

  // Runs the existing single-pass hasher against an already-existing card
  // (created via beginEntry). `hashableFile` is either the file the user
  // actually dropped, or a synthetic File built from an archive entry's
  // decompressed bytes — computeAllHashes can't tell the difference and
  // doesn't need to, since a File is all it has ever required.
  const finishHashing = useCallback(async (key: number, hashableFile: File, displayName: string, sourceArchiveName?: string) => {
    updateEntry(key, { phase: 'hashing', progress: 0, filename: displayName, fileSize: hashableFile.size, processing: true, sourceArchiveName });
    try {
      const { crc32, md5, sha1 } = await computeAllHashes(hashableFile, (progress) => updateEntry(key, { progress }));
      const result: ROMFileInfo = {
        filename: displayName, fileSize: hashableFile.size, crc32, md5, sha1,
        processing: false, progress: 100, sourceArchiveName,
      };
      updateEntry(key, result);
      onFileProcessed?.(result);
    } catch {
      updateEntry(key, { processing: false, error: 'Processing failed — please try again.' });
    }
  }, [onFileProcessed, updateEntry]);

  const processFile = useCallback(async (file: File) => {
    const format = classifyArchive(file.name);

    if (format.kind === 'unsupported') {
      addErrorEntry(file.name, file.size, `${format.label} archives can't be auto-extracted yet — extract the ROM yourself, then drop it in directly.`);
      return;
    }

    if (format.kind === 'zip') {
      // Starts out representing the archive itself (name/size), since
      // which file inside it is "the ROM" isn't known until it's read.
      const key = beginEntry(file.name, file.size, undefined, 'extracting');
      const result = await readZipCandidates(file);
      if (!result.ok) {
        updateEntry(key, { processing: false, error: result.error });
        return;
      }

      // Auto-pick only when it's unambiguous — see pickAutoCandidate's own
      // comment for the exact tiers. Anything less certain asks instead
      // of guessing (e.g. multiple ROM-looking files, such as two
      // regional variants).
      const chosen = pickAutoCandidate(result.candidates);

      if (!chosen) {
        setFiles((prev) => prev.filter((f) => f._key !== key));
        setPendingArchives((prev) => [
          ...prev,
          {
            key: ++archiveKeyCounter.current,
            archiveFile: file,
            candidates: [...result.candidates].sort(
              (a, b) => Number(b.looksLikeRom) - Number(a.looksLikeRom) || (b.size ?? 0) - (a.size ?? 0)
            ),
            extract: result.extract,
          },
        ]);
        return;
      }

      updateEntry(key, { filename: chosen.basename, fileSize: chosen.size ?? file.size, sourceArchiveName: file.name });
      try {
        const bytes = await result.extract(chosen.path, (percent) => updateEntry(key, { progress: percent }));
        // Re-wrapped in a plain `new Uint8Array(...)` rather than passed
        // straight through: this always allocates a fresh, concrete
        // ArrayBuffer-backed copy, which is what File/Blob's BlobPart type
        // actually requires. jszip's own return type (and, below, the
        // manually-accumulated gzip buffer) types as the wider
        // Uint8Array<ArrayBufferLike> under current TS, which File's
        // constructor correctly refuses at the type level since
        // ArrayBufferLike also covers SharedArrayBuffer — real browsers
        // throw at runtime if you hand them a shared-buffer view here, so
        // this isn't just a type-checker technicality. Nothing in this
        // codebase ever produces a SharedArrayBuffer-backed view, so the
        // copy is purely to satisfy that guarantee explicitly rather than
        // asserting past it; the cost is one extra copy of an already-
        // in-memory ROM, negligible next to the extraction that just ran.
        const innerFile = new File([new Uint8Array(bytes)], chosen.basename, { lastModified: file.lastModified });
        await finishHashing(key, innerFile, chosen.basename, file.name);
      } catch (err) {
        updateEntry(key, { processing: false, error: err instanceof Error ? err.message : "Couldn't extract this file — please try again." });
      }
      return;
    }

    if (format.kind === 'sevenzip') {
      // Same overall shape as the zip branch above (candidates + optional
      // picker), but starts in a 'loading' phase first — unlike zip/gzip,
      // this format's reader (7z-wasm) isn't already bundled, so there's a
      // real, sometimes-noticeable fetch+init step before any listing can
      // even happen. See src/lib/archiveExtract.ts's "7-ZIP / RAR" section
      // for the full reasoning, including why extraction progress below
      // is always null (no fabricated percentage) rather than a number.
      const key = beginEntry(file.name, file.size, undefined, 'loading');
      updateEntry(key, { progress: null });
      const result = await read7zCandidates(file, format.label);
      if (!result.ok) {
        updateEntry(key, { processing: false, error: result.error });
        return;
      }
      updateEntry(key, { phase: 'extracting' });

      const chosen = pickAutoCandidate(result.candidates);

      if (!chosen) {
        setFiles((prev) => prev.filter((f) => f._key !== key));
        setPendingArchives((prev) => [
          ...prev,
          {
            key: ++archiveKeyCounter.current,
            archiveFile: file,
            candidates: [...result.candidates].sort(
              (a, b) => Number(b.looksLikeRom) - Number(a.looksLikeRom) || (b.size ?? 0) - (a.size ?? 0)
            ),
            extract: result.extract,
          },
        ]);
        return;
      }

      updateEntry(key, { filename: chosen.basename, fileSize: chosen.size ?? file.size, sourceArchiveName: file.name });
      try {
        const bytes = await result.extract(chosen.path, (percent) => updateEntry(key, { progress: percent }));
        // Same reasoning as the zip/gzip File-construction sites below.
        const innerFile = new File([new Uint8Array(bytes)], chosen.basename, { lastModified: file.lastModified });
        await finishHashing(key, innerFile, chosen.basename, file.name);
      } catch (err) {
        updateEntry(key, { processing: false, error: err instanceof Error ? err.message : "Couldn't extract this file — please try again." });
      }
      return;
    }

    if (format.kind === 'gzip') {
      // Gzip is a single compressed stream, not a multi-file archive —
      // there's never a choice to make, so this goes straight through.
      const key = beginEntry(file.name, file.size, undefined, 'extracting');
      const result = await readGzipFile(file);
      if (!result.ok) {
        updateEntry(key, { processing: false, error: result.error });
        return;
      }
      // Same reasoning as the zip path above: force a concrete
      // ArrayBuffer-backed copy so this satisfies BlobPart.
      const innerFile = new File([new Uint8Array(result.bytes)], result.innerName, { lastModified: file.lastModified });
      await finishHashing(key, innerFile, result.innerName, file.name);
      return;
    }

    // Not an archive — same behavior as before this feature existed.
    const key = beginEntry(file.name, file.size);
    await finishHashing(key, file, file.name);
  }, [beginEntry, updateEntry, finishHashing, addErrorEntry]);

  const chooseArchiveCandidate = useCallback(async (pending: PendingArchive, candidate: ArchiveCandidate) => {
    setPendingArchives((prev) => prev.filter((p) => p.key !== pending.key));
    const key = beginEntry(candidate.basename, candidate.size ?? pending.archiveFile.size, pending.archiveFile.name, 'extracting');
    try {
      const bytes = await pending.extract(candidate.path, (percent) => updateEntry(key, { progress: percent }));
      // Same reasoning as the two call sites above.
      const innerFile = new File([new Uint8Array(bytes)], candidate.basename, { lastModified: pending.archiveFile.lastModified });
      await finishHashing(key, innerFile, candidate.basename, pending.archiveFile.name);
    } catch (err) {
      updateEntry(key, { processing: false, error: err instanceof Error ? err.message : "Couldn't extract this file — please try again." });
    }
  }, [beginEntry, updateEntry, finishHashing]);

  const handleFiles = useCallback((list: FileList | null) => {
    if (!list) return;
    Array.from(list).forEach(processFile);
  }, [processFile]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  return (
    <div className="space-y-4">
      <div
        onDrop={onDrop}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onClick={() => inputRef.current?.click()}
        className={clsx(
          'relative border-2 border-dashed rounded-xl p-10 cursor-pointer transition-all',
          'flex flex-col items-center justify-center gap-4 text-center select-none',
          dragging ? 'border-phosphor bg-phosphor/5 shadow-phosphor' : 'border-border hover:border-phosphor/50 hover:bg-bg-elevated'
        )}
      >
        <div className={clsx('w-14 h-14 rounded-full flex items-center justify-center transition-all', dragging ? 'bg-phosphor/20' : 'bg-bg-elevated')}>
          <Upload size={24} className={dragging ? 'text-phosphor' : 'text-text-muted'} />
        </div>
        <div>
          <p className="text-text-primary font-medium">{dragging ? 'Drop to process' : (label ?? 'Select or drop ROM files')}</p>
          <p className="text-text-muted text-sm mt-1">{hint ?? 'Hashes computed locally — the ROM file never leaves your browser'}</p>
        </div>
        <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => handleFiles(e.target.files)} />
      </div>

      {files.length === 0 && pendingArchives.length === 0 && (
        <div className="flex items-start gap-3 p-3 rounded-lg bg-phosphor/5 border border-phosphor/20">
          <div className="w-5 h-5 rounded-full bg-phosphor/20 flex items-center justify-center shrink-0 mt-0.5">
            <span className="text-phosphor text-xs font-bold">i</span>
          </div>
          <p className="text-xs text-text-secondary leading-relaxed">
            <strong className="text-phosphor">Privacy guaranteed.</strong> ROM files are processed entirely in your browser — CRC32, MD5, and SHA-1 are all computed in one read, and a .zip or .gz is extracted locally first if you drop one in. Only the resulting hashes are submitted to the database.
          </p>
        </div>
      )}

      {pendingArchives.length > 0 && (
        <div className="space-y-3">
          {pendingArchives.map((p) => (
            <ArchivePickerCard
              key={p.key}
              pending={p}
              onChoose={(candidate) => chooseArchiveCandidate(p, candidate)}
              onCancel={() => setPendingArchives((prev) => prev.filter((x) => x.key !== p.key))}
            />
          ))}
        </div>
      )}

      {files.length > 0 && (
        <div className="space-y-3">
          {files.map((info) => (
            <FileCard
              key={info._key}
              info={info}
              onUse={showUseButton && !info.processing && !info.error ? onFileProcessed : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}
