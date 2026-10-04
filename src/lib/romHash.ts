// src/lib/romHash.ts
//
// Single-pass CRC32 + MD5 + SHA-1 of a File, entirely in the browser.
//
// Moved verbatim out of src/components/ROMProcessor.tsx (Sep 29 2026) so the
// bulk-submit flow can reuse the exact same hasher instead of growing a
// second copy of it (this project has been bitten repeatedly by a second
// hand-maintained copy drifting out of sync — see CLAUDE_HANDOFF.txt
// section 4). The function body below is byte-for-byte what used to live in
// ROMProcessor.tsx; the only change is the added `export`. ROMProcessor.tsx
// now imports it from here.
//
// Client-only by nature (takes a File, reads it in chunks via
// File.slice().arrayBuffer()). Nothing here ever sends a byte anywhere —
// HackHash's standing rule is that ROM bytes never leave the browser.

import SparkMD5 from 'spark-md5';

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

export async function computeAllHashes(
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
