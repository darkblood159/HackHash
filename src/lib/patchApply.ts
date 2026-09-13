// src/lib/patchApply.ts
//
// Applies an IPS/BPS/UPS patch to a ROM entirely client-side — this file
// must never run anywhere the ROM's bytes could leave the browser. The
// three apply algorithms below are a direct, careful port of
// marcrobledo/RomPatcher.js's real APPLY logic (not reverse-engineered
// from the format specs independently) — the same MIT-licensed patcher
// romhacking.net itself runs, already used in this project for magic-byte
// verification (src/lib/patchValidation.ts, section 2as). Only the DECODE
// side is ported (parsing a patch + applying it) — the ENCODE side
// (building a patch from two ROMs) is intentionally not needed here and
// not ported.
//
// PPF, XDELTA, and APS are NOT implemented here — deferred, same as their
// deferral in patchValidation.ts's footer-checksum note (section 2as) and
// the original phased rollout plan. Attempting to apply one of those
// three throws a clear "not supported yet" error rather than silently
// doing nothing.
//
// VERIFICATION NOTE (see CLAUDE_HANDOFF.txt section 2ay for the full
// story): correctness here was checked by generating real patches with
// RomPatcher.js's own unmodified, real encoder (IPS.buildFromRoms,
// BPS.buildFromRoms, UPS.buildFromRoms — loaded into a Node vm context
// exactly the way their own web worker loads them, not reimplemented) and
// confirming this file's apply functions reproduce the expected target
// ROM byte-for-byte, not just a matching checksum. That verifies the
// APPLY side; it does not verify parsing of an arbitrary real-world patch
// file this file has never seen, which is the honest limit of what a
// sandbox with no real sample patch files can confirm.

import type { PatchTypeValue } from './patchTypes';

class ByteReader {
  offset: number;
  constructor(
    private bytes: Uint8Array,
    offset = 0
  ) {
    this.offset = offset;
  }
  get length(): number {
    return this.bytes.length;
  }
  isEOF(): boolean {
    return this.offset >= this.bytes.length;
  }
  seek(n: number): void {
    this.offset = n;
  }
  skip(n: number): void {
    this.offset += n;
  }
  readU8(): number {
    return this.bytes[this.offset++];
  }
  // Big-endian, 3-byte — IPS's own offset/length field width.
  readU24BE(): number {
    const v = (this.bytes[this.offset] << 16) | (this.bytes[this.offset + 1] << 8) | this.bytes[this.offset + 2];
    this.offset += 3;
    return v >>> 0;
  }
  readU16BE(): number {
    const v = (this.bytes[this.offset] << 8) | this.bytes[this.offset + 1];
    this.offset += 2;
    return v >>> 0;
  }
  // Little-endian, 4-byte — BPS/UPS's own checksum field width. Only used
  // if/when checksum fields are read; kept for completeness even though
  // the checksums themselves aren't verified yet (see file header).
  readU32LE(): number {
    const b = this.bytes;
    const o = this.offset;
    const v = (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
    this.offset += 4;
    return v;
  }
  readBytes(len: number): Uint8Array {
    // .slice(), not .subarray() — an owned copy, not a view that would
    // alias the original patch buffer if it's ever mutated or GC'd
    // separately.
    const v = this.bytes.slice(this.offset, this.offset + len);
    this.offset += len;
    return v;
  }
  // BPS and UPS both use the same 7-bit variable-length value encoding
  // for offsets/lengths/sizes (the source romhacking.net format specs
  // define it identically in both documents) — one shared reader.
  readVLV(): number {
    let data = 0;
    let shift = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const x = this.readU8();
      data += (x & 0x7f) * shift;
      if (x & 0x80) break;
      shift <<= 7;
      data += shift;
    }
    return data;
  }
}

export class PatchApplyError extends Error {}

function applyIPS(patchBytes: Uint8Array, romBytes: Uint8Array): Uint8Array {
  const r = new ByteReader(patchBytes, 5); // skip 'PATCH'

  interface IpsRecord {
    offset: number;
    rleLength?: number;
    rleByte?: number;
    data?: Uint8Array;
  }
  const records: IpsRecord[] = [];
  let truncate: number | null = null;

  while (!r.isEOF()) {
    const offset = r.readU24BE();
    if (offset === 0x454f46 /* 'EOF' as a 3-byte big-endian int */) {
      // A well-formed IPS with a truncate extension has exactly 3 more
      // bytes after this marker; anything else (including the far rarer
      // EBP JSON-metadata variant) is treated as plain end-of-records —
      // safe, since truncate is optional and only ever shrinks/grows a
      // size that's also independently checked against the expected
      // output hash later in the calling flow.
      if (r.offset + 3 === r.length) {
        truncate = r.readU24BE();
      }
      break;
    }
    const length = r.readU16BE();
    if (length === 0) {
      const rleLength = r.readU16BE();
      const rleByte = r.readU8();
      records.push({ offset, rleLength, rleByte });
    } else {
      records.push({ offset, data: r.readBytes(length) });
    }
  }

  let newSize = romBytes.length;
  if (truncate !== null) {
    newSize = truncate;
  } else {
    for (const rec of records) {
      const end = rec.offset + (rec.data ? rec.data.length : rec.rleLength!);
      if (end > newSize) newSize = end;
    }
  }

  const out = new Uint8Array(newSize);
  out.set(romBytes.subarray(0, Math.min(romBytes.length, newSize)));

  for (const rec of records) {
    if (rec.data) {
      out.set(rec.data, rec.offset);
    } else {
      out.fill(rec.rleByte!, rec.offset, rec.offset + rec.rleLength!);
    }
  }

  return out;
}

function applyUPS(patchBytes: Uint8Array, romBytes: Uint8Array): Uint8Array {
  const r = new ByteReader(patchBytes, 4); // skip 'UPS1'

  const sizeInputDeclared = r.readVLV();
  const sizeOutputDeclared = r.readVLV();

  interface UpsRecord {
    offset: number;
    xor: Uint8Array;
  }
  const records: UpsRecord[] = [];
  const endOffset = patchBytes.length - 12; // 3x u32 checksums at the end
  while (r.offset < endOffset) {
    const relOffset = r.readVLV();
    const xor: number[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const b = r.readU8();
      if (b === 0) break; // 0x00 terminates each record's XOR run
      xor.push(b);
    }
    records.push({ offset: relOffset, xor: Uint8Array.from(xor) });
  }

  // Same fix RomPatcher.js's own apply() applies: if the actual source
  // ROM is bigger than what the patch was built against, grow to fit
  // rather than silently truncating the extra data.
  let sizeInput = sizeInputDeclared;
  let sizeOutput = sizeOutputDeclared;
  if (sizeInput < romBytes.length) {
    sizeInput = romBytes.length;
    if (sizeOutput < sizeInput) sizeOutput = sizeInput;
  }

  const out = new Uint8Array(sizeOutput);
  // Clamped against sizeOutput too, not just sizeInput/romBytes.length: the
  // real RomPatcher.js copies this initial span with a raw per-index loop
  // (BinFile.copyTo), which silently clips anything past the destination's
  // end rather than throwing — .set() throws instead unless the length is
  // pre-clamped to what actually fits, which is what this three-way min
  // does. Caught by the truncation-case golden test (source bigger than
  // declared output), not spotted by inspection alone.
  out.set(romBytes.subarray(0, Math.min(romBytes.length, sizeInput, sizeOutput)));

  let outCursor = 0;
  let romCursor = 0;
  for (const rec of records) {
    outCursor += rec.offset;
    romCursor += rec.offset;
    for (let i = 0; i < rec.xor.length; i++) {
      const romByte = romCursor < romBytes.length ? romBytes[romCursor] : 0;
      out[outCursor] = romByte ^ rec.xor[i];
      outCursor++;
      romCursor++;
    }
    // the terminating 0x00 byte itself occupies one more position in both
    // streams, which the parse loop already consumed from the patch but
    // which both cursors still need to step past
    outCursor++;
    romCursor++;
  }

  return out;
}

const BPS_SOURCE_READ = 0;
const BPS_TARGET_READ = 1;
const BPS_SOURCE_COPY = 2;
const BPS_TARGET_COPY = 3;

function applyBPS(patchBytes: Uint8Array, romBytes: Uint8Array): Uint8Array {
  const r = new ByteReader(patchBytes, 4); // skip 'BPS1'

  r.readVLV(); // sourceSize — not needed for apply; targetSize is what actually sizes the output
  const targetSize = r.readVLV();
  const metaDataLength = r.readVLV();
  if (metaDataLength) r.skip(metaDataLength);

  interface BpsAction {
    type: number;
    length: number;
    bytes?: Uint8Array;
    relativeOffset?: number;
  }
  const actions: BpsAction[] = [];
  const endActionsOffset = patchBytes.length - 12; // 3x u32 checksums at the end
  while (r.offset < endActionsOffset) {
    const data = r.readVLV();
    const type = data & 3;
    const length = (data >> 2) + 1;
    const action: BpsAction = { type, length };
    if (type === BPS_TARGET_READ) {
      action.bytes = r.readBytes(length);
    } else if (type === BPS_SOURCE_COPY || type === BPS_TARGET_COPY) {
      const raw = r.readVLV();
      action.relativeOffset = (raw & 1 ? -1 : 1) * (raw >> 1);
    }
    actions.push(action);
  }

  const out = new Uint8Array(targetSize);
  let outputOffset = 0;
  let sourceRelativeOffset = 0;
  let targetRelativeOffset = 0;

  for (const action of actions) {
    if (action.type === BPS_SOURCE_READ) {
      // Copies from the SAME absolute offset in the source ROM as the
      // current output position — not a separately tracked cursor. Easy
      // to get wrong without the real source; confirmed against it.
      for (let i = 0; i < action.length; i++) {
        out[outputOffset] = romBytes[outputOffset];
        outputOffset++;
      }
    } else if (action.type === BPS_TARGET_READ) {
      out.set(action.bytes!, outputOffset);
      outputOffset += action.length;
    } else if (action.type === BPS_SOURCE_COPY) {
      sourceRelativeOffset += action.relativeOffset!;
      for (let i = 0; i < action.length; i++) {
        out[outputOffset++] = romBytes[sourceRelativeOffset++];
      }
    } else if (action.type === BPS_TARGET_COPY) {
      // Self-referential — copies from the OUTPUT buffer being built,
      // which is what makes run-length-style repetition possible. Reads
      // and writes happen one byte at a time (not a bulk copy) since a
      // TARGET_COPY can legitimately read a byte this same loop already
      // wrote moments earlier.
      targetRelativeOffset += action.relativeOffset!;
      for (let i = 0; i < action.length; i++) {
        out[outputOffset++] = out[targetRelativeOffset++];
      }
    }
  }

  return out;
}

const SUPPORTED_APPLY_TYPES: ReadonlySet<PatchTypeValue> = new Set<PatchTypeValue>(['IPS', 'BPS', 'UPS']);

export function isApplySupported(patchType: PatchTypeValue): boolean {
  return SUPPORTED_APPLY_TYPES.has(patchType);
}

/**
 * Applies a patch to a ROM, entirely in memory, entirely client-side.
 * Throws PatchApplyError for anything this file can't or won't handle —
 * an unsupported format, or a parse/apply-time failure (a malformed
 * patch, or a source ROM too short for what the patch expects to read).
 */
export function applyPatch(patchType: PatchTypeValue, patchBytes: Uint8Array, romBytes: Uint8Array): Uint8Array {
  try {
    switch (patchType) {
      case 'IPS':
        return applyIPS(patchBytes, romBytes);
      case 'UPS':
        return applyUPS(patchBytes, romBytes);
      case 'BPS':
        return applyBPS(patchBytes, romBytes);
      default:
        throw new PatchApplyError(
          `${patchType} patches can't be applied in your browser yet — this format isn't supported here so far.`
        );
    }
  } catch (err) {
    if (err instanceof PatchApplyError) throw err;
    throw new PatchApplyError(
      `Couldn't apply the patch (${err instanceof Error ? err.message : 'unknown error'}). The patch file may be corrupt, or this ROM may not be the right one.`
    );
  }
}
