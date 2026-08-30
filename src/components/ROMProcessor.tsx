'use client';

// src/components/ROMProcessor.tsx
import React, { useState, useCallback, useRef } from 'react';
import SparkMD5 from 'spark-md5';
import { Upload, FileCheck, Copy, CheckCheck, AlertCircle, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';
import type { ROMFileInfo } from '@/types';

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
        <span className="font-mono text-sm text-text-primary truncate flex-1">{info.filename}</span>
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
              <span>Computing hashes…</span>
              <span>{Math.round(info.progress)}%</span>
            </div>
            <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden">
              <div
                className="h-full bg-phosphor rounded-full transition-all duration-100"
                style={{ width: `${info.progress}%` }}
              />
            </div>
            <p className="text-[10px] text-text-muted">
              {formatBytes(Math.round(info.fileSize * info.progress / 100))} of {formatBytes(info.fileSize)} processed
            </p>
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

// ─── Main component ───────────────────────────────────────────────────────────

interface ROMProcessorProps {
  onFileProcessed?: (info: ROMFileInfo) => void;
  showUseButton?: boolean;
  label?: string;
  hint?: string;
}

export function ROMProcessor({
  onFileProcessed,
  showUseButton = true,
  label,
  hint,
}: ROMProcessorProps) {
  const [files, setFiles] = useState<ROMFileInfo[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const processFile = useCallback(async (file: File) => {
    // Archives must be blocked — the hash of a ZIP/7z/RAR reflects the
    // container (compression, metadata, timestamps) not the ROM inside it.
    // The same ROM packed differently would produce completely different
    // hashes, making every submission unreproducible by other verifiers.
    const BLOCKED_EXTS = ['.zip', '.7z', '.rar', '.gz', '.bz2', '.xz', '.tar', '.z', '.lzh', '.lha', '.cab'];
    const lc = file.name.toLowerCase();
    if (BLOCKED_EXTS.some((ext) => lc.endsWith(ext))) {
      setFiles((prev) => [
        ...prev,
        {
          filename: file.name,
          fileSize: file.size,
          crc32: '', md5: '', sha1: '',
          processing: false, progress: 0,
          error: `Archive files can't be hashed — extract the ROM from the ${lc.split('.').pop()?.toUpperCase()} first, then drop the ROM file directly.`,
        },
      ]);
      return;
    }
    const key = `${file.name}-${file.size}`;

    const initial: ROMFileInfo = {
      filename: file.name, fileSize: file.size,
      crc32: '', md5: '', sha1: '',
      processing: true, progress: 0,
    };
    setFiles((prev) => [...prev, initial]);

    try {
      const { crc32, md5, sha1 } = await computeAllHashes(file, (progress) => {
        setFiles((prev) =>
          prev.map((f) => (f.filename === file.name && f.fileSize === file.size ? { ...f, progress } : f))
        );
      });

      const result: ROMFileInfo = { filename: file.name, fileSize: file.size, crc32, md5, sha1, processing: false, progress: 100 };
      setFiles((prev) =>
        prev.map((f) => (f.filename === file.name && f.fileSize === file.size ? result : f))
      );
      onFileProcessed?.(result);
    } catch {
      setFiles((prev) =>
        prev.map((f) =>
          f.filename === file.name && f.fileSize === file.size
            ? { ...f, processing: false, error: 'Processing failed — please try again.' }
            : f
        )
      );
    }
  }, [onFileProcessed]);

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

      {files.length === 0 && (
        <div className="flex items-start gap-3 p-3 rounded-lg bg-phosphor/5 border border-phosphor/20">
          <div className="w-5 h-5 rounded-full bg-phosphor/20 flex items-center justify-center shrink-0 mt-0.5">
            <span className="text-phosphor text-xs font-bold">i</span>
          </div>
          <p className="text-xs text-text-secondary leading-relaxed">
            <strong className="text-phosphor">Privacy guaranteed.</strong> ROM files are processed entirely in your browser using a single-pass algorithm — CRC32, MD5, and SHA-1 are all computed in one read. Only the resulting hashes are submitted to the database.
          </p>
        </div>
      )}

      {files.length > 0 && (
        <div className="space-y-3">
          {files.map((info, i) => (
            <FileCard
              key={`${info.filename}-${info.fileSize}-${i}`}
              info={info}
              onUse={showUseButton && !info.processing && !info.error ? onFileProcessed : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}
