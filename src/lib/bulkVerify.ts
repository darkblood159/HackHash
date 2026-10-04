// src/lib/bulkVerify.ts
//
// The proof step for bulk patches: apply a patch to the base ROM, in the
// browser, and check that the result is EXACTLY the ROM the row claims. When
// it is, the pairing "this patch belongs with this version" stops being a
// guess about file names and becomes a fact — the patch demonstrably produces
// that ROM. Only IPS / BPS / UPS can be applied in a browser today (see
// patchApply.ts); other formats report 'unsupported' and keep their
// name-based pairing.
//
// A mismatch is a WARNING, not a block: a ROM dumped with a copier header, or
// a different-but-equivalent dump, legitimately won't reproduce byte for byte.
// The person is told and decides.
//
// Nothing here leaves the browser; the base ROM and patch bytes are only ever
// held in memory for the duration of the check.

import { applyPatch, isApplySupported, PatchApplyError } from './patchApply';
import { sha1Hex, type PatchTypeValue } from './patchTypes';

export type PatchVerification =
  | { state: 'verified' }
  | { state: 'mismatch'; detail: string }
  | { state: 'unsupported'; detail: string }
  | { state: 'error'; detail: string };

// A convenience pre-check only — the SERVER is the authority on what a patch
// is (detectPatchFormat in patchValidation.ts, which needs Node's Buffer and
// so can't be shared with browser code). This exists because patchApply.ts's
// IPS reader skips the 5-byte header without checking it, so a file that
// isn't a patch at all would "apply" into garbage and be reported as a
// hash MISMATCH — true, but misleading. Mirrors the server's magic bytes for
// just the three formats a browser can apply.
function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...Array.from(bytes.subarray(from, to)));
}
function looksLikeApplicablePatch(type: PatchTypeValue, bytes: Uint8Array): boolean {
  if (type === 'IPS') return bytes.length >= 8 && ascii(bytes, 0, 5) === 'PATCH' && ascii(bytes, bytes.length - 3, bytes.length) === 'EOF';
  if (type === 'BPS') return bytes.length >= 4 && ascii(bytes, 0, 4) === 'BPS1';
  if (type === 'UPS') return bytes.length >= 4 && ascii(bytes, 0, 4) === 'UPS1';
  return false;
}

/**
 * Applies `patchFile` to `baseRomBytes` and compares the SHA-1 of the output
 * to `expectedSha1` (the row's ROM hash).
 */
export async function verifyPatchProducesRom(args: {
  patchType: PatchTypeValue | null;
  patchFile: File;
  baseRomBytes: Uint8Array;
  expectedSha1: string;
}): Promise<PatchVerification> {
  const { patchType, patchFile, baseRomBytes, expectedSha1 } = args;
  if (!patchType || !isApplySupported(patchType)) {
    return { state: 'unsupported', detail: "This patch format can't be applied in a browser, so it couldn't be checked against the ROM." };
  }
  try {
    const patchBytes = new Uint8Array(await patchFile.arrayBuffer());
    if (!looksLikeApplicablePatch(patchType, patchBytes)) {
      return { state: 'error', detail: `This file doesn't look like a valid ${patchType} patch — it may be corrupt or mislabelled.` };
    }
    const out = applyPatch(patchType, patchBytes, baseRomBytes);
    // sha1Hex (native crypto.subtle) rather than the JS hasher: this only
    // needs SHA-1 and runs once per row, so the fast path matters.
    const actual = await sha1Hex(new File([new Uint8Array(out)], 'patched.bin'));
    return actual === expectedSha1.toLowerCase()
      ? { state: 'verified' }
      : { state: 'mismatch', detail: "Applying this patch to the base ROM doesn't give the same file as this version's ROM." };
  } catch (err) {
    if (err instanceof PatchApplyError) return { state: 'error', detail: err.message };
    return { state: 'error', detail: "Couldn't check this patch." };
  }
}
