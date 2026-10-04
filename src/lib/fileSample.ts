// src/lib/fileSample.ts
//
// A "sample" of a file: its total size, its first SAMPLE_HEAD_BYTES, and its
// last SAMPLE_TAIL_BYTES. That is everything patchValidation.ts and
// romDetection.ts actually look at:
//   - patch magic bytes live in the first 5 bytes;
//   - IPS additionally checks that the file's last 3 bytes are "EOF";
//   - ROM/disc-image signatures live at fixed offsets, the deepest being
//     ISO 9660's "CD001" at byte 32769 (romDetection.ts).
// Nothing else in validation reads file content, so validating a sample is
// exactly equivalent to validating the whole buffer — this is what lets the
// chunked upload path (patchUploadSession.ts) validate a multi-GB file that
// was streamed straight to disk without ever loading it into memory.
//
// The legacy single-request upload path and every existing Buffer-based
// caller go through sampleFromBuffer(), so there is ONE implementation of
// each check (in the *FromSample functions), not two that could drift apart.
//
// The head window must always be at least as deep as the deepest offset
// romDetection.ts reads. patchValidation.ts asserts that at module load
// (ROM_DETECTION_MAX_READ_BYTES <= SAMPLE_HEAD_BYTES) so a future signature
// added at a deeper offset fails loudly at startup instead of silently never
// matching on the chunked path.

import { promises as fs } from 'fs';

export const SAMPLE_HEAD_BYTES = 64 * 1024;
export const SAMPLE_TAIL_BYTES = 16;

export interface FileSample {
  /** Total size of the file in bytes. */
  size: number;
  /** First min(size, SAMPLE_HEAD_BYTES) bytes. */
  head: Buffer;
  /** Last min(size, SAMPLE_TAIL_BYTES) bytes. */
  tail: Buffer;
}

export function sampleFromBuffer(bytes: Buffer): FileSample {
  return {
    size: bytes.length,
    head: bytes.subarray(0, SAMPLE_HEAD_BYTES),
    tail: bytes.subarray(Math.max(0, bytes.length - SAMPLE_TAIL_BYTES)),
  };
}

async function readExactly(
  handle: fs.FileHandle,
  length: number,
  position: number
): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buf, filled, length - filled, position + filled);
    if (bytesRead === 0) break; // file shrank underneath us — return what exists
    filled += bytesRead;
  }
  return filled === length ? buf : buf.subarray(0, filled);
}

/** Reads only the head and tail of a file on disk. Never loads the whole file. */
export async function sampleFromFile(filePath: string): Promise<FileSample> {
  const handle = await fs.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const head = await readExactly(handle, Math.min(size, SAMPLE_HEAD_BYTES), 0);
    const tailLength = Math.min(size, SAMPLE_TAIL_BYTES);
    const tail = await readExactly(handle, tailLength, size - tailLength);
    return { size, head, tail };
  } finally {
    await handle.close();
  }
}
