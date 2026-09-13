// src/lib/patchValidation.ts
//
// Server-side validation for an uploaded patch file — this is the actual
// legality gate for POST /api/submissions/[id]/patch, not a UX nicety.
// patchTypeFromFilename() in patchTypes.ts reads a filename extension,
// which is fine for pre-filling a form field but proves nothing about an
// upload: anyone can rename game.iso to game.bps and POST it directly.
// What actually stops a full ROM/ISO from being accepted as a "patch" is
// the magic-byte / structural check below, run against the real bytes the
// server received.
//
// Every signature here was checked against the CURRENT real source of
// marcrobledo/RomPatcher.js (MIT-licensed; romhacking.net's own patcher,
// github.com/marcrobledo/RomPatcher.js) rather than recalled from memory —
// same "read the actual shipped source, don't trust a doc comment" rule
// this project already applied to @upstash/ratelimit and NextAuth. Exact
// files checked, for whoever revisits this:
//   rom-patcher-js/modules/RomPatcher.format.ips.js   -> IPS_MAGIC
//   rom-patcher-js/modules/RomPatcher.format.bps.js   -> BPS_MAGIC
//   rom-patcher-js/modules/RomPatcher.format.ups.js   -> UPS_MAGIC
//   rom-patcher-js/modules/RomPatcher.format.ppf.js   -> PPF_MAGIC + version digits
//   rom-patcher-js/modules/RomPatcher.format.vcdiff.js -> VCDIFF_MAGIC + version byte
//   rom-patcher-js/modules/RomPatcher.format.aps_gba.js -> APS_GBA_MAGIC
//   rom-patcher-js/modules/RomPatcher.format.aps_n64.js -> APS_N64_MAGIC
//
// NOT implemented here, on purpose: the BPS/UPS footer CRC32 self-checks
// (patch-integrity checksums both formats carry in their last 12/8 bytes).
// Both formats support it and it would be a genuine extra integrity layer
// on top of the sha1-must-match check the upload endpoint already does,
// but getting the exact byte range each checksum covers wrong is an easy,
// quiet mistake, and there's no real sample IPS/BPS/UPS/PPF/XDELTA/APS
// file in this sandbox to test against — same reasoning this project
// already used to hold off shipping untested RAR handling. Worth adding
// once real fixtures are available to verify against; flagged in the
// handoff rather than shipped unverified.
import type { PatchTypeValue } from './patchTypes';

// First guess, not a researched number — cart-based IPS/BPS/UPS patches
// are almost always well under 1MB; even a generous disc-based XDELTA/PPF
// patch rarely needs more than a few tens of MB. Override with
// PATCH_MAX_UPLOAD_BYTES if a real submission legitimately needs more.
const DEFAULT_MAX_PATCH_FILE_SIZE_BYTES = 64 * 1024 * 1024; // 64MB
export const MAX_PATCH_FILE_SIZE_BYTES = (() => {
  const raw = process.env.PATCH_MAX_UPLOAD_BYTES;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PATCH_FILE_SIZE_BYTES;
})();

export function isValidSha1Hex(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

/**
 * Sniffs a buffer's header (and, where cheap and reliable, its structure)
 * against every format's real magic bytes. Returns the detected
 * PatchTypeValue, or null if nothing matched — never guesses.
 */
export function detectPatchFormat(bytes: Buffer): PatchTypeValue | null {
  if (bytes.length < 4) return null;

  // IPS — 'PATCH' (5 bytes). A real IPS parser walks record-by-record
  // looking for a 3-byte offset value of 0x454f46 ('EOF' as a big-endian
  // int) as the end-of-records marker. Replicating that whole walk is more
  // than this gate needs; checking that the file's literal last 3 bytes
  // are 'EOF' is a real structural signal (not just "starts with PATCH")
  // at a fraction of the complexity, and matches a well-formed IPS with no
  // trailing junk after the marker.
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === 'PATCH') {
    if (bytes.length >= 8 && bytes.subarray(-3).toString('ascii') === 'EOF') {
      return 'IPS';
    }
    return null; // starts like IPS but doesn't end like one
  }

  if (bytes.subarray(0, 4).toString('ascii') === 'BPS1') return 'BPS';
  if (bytes.subarray(0, 4).toString('ascii') === 'UPS1') return 'UPS';

  // PPF — 'PPF' (3 bytes) followed by a 2-digit ASCII version string
  // ('10'/'20'/'30' for v1.0/2.0/3.0), read as its own field by
  // RomPatcher.js rather than being part of one fixed 5-byte magic.
  // Checking both is stronger than checking either alone.
  if (bytes.length >= 5 && bytes.subarray(0, 3).toString('ascii') === 'PPF') {
    const versionDigits = bytes.subarray(3, 5).toString('ascii');
    return /^[0-9]{2}$/.test(versionDigits) ? 'PPF' : null;
  }

  // VCDIFF (RFC 3284, what this project's XDELTA enum value means in
  // practice) — 3 magic bytes 0xD6 0xC3 0xC4 plus a version byte that RFC
  // 3284 defines as always 0x00 for the only version ever specified.
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xd6 &&
    bytes[1] === 0xc3 &&
    bytes[2] === 0xc4 &&
    bytes[3] === 0x00
  ) {
    return 'XDELTA';
  }

  // APS covers two historically distinct, differently-specced formats
  // that share this project's single APS enum value: APS_GBA ('APS1',
  // 4 bytes) and APS_N64 ('APS10', 5 bytes). 'APS10' starts with 'APS1',
  // so checking the shorter 4-byte prefix alone already matches both —
  // there's no need to special-case the 5-byte one separately, and no
  // ambiguity, since both variants map to the same 'APS' return value
  // here. If APS_GBA vs APS_N64 ever needs distinguishing in the UI (they
  // really are different formats), PatchType would need splitting into
  // two enum values — out of scope for this validation gate, flagged in
  // the handoff instead of guessed at.
  if (bytes.subarray(0, 4).toString('ascii') === 'APS1') return 'APS';

  return null;
}

export interface PatchValidationResult {
  ok: boolean;
  reason?: string;
  detectedType?: PatchTypeValue;
}

/**
 * Confirms a buffer is really some recognized patch format — the actual
 * gate keeping a renamed ROM/ISO from being accepted as a "patch upload".
 * Deliberately does NOT compare against a declared type itself (it used
 * to — see git history / section 2as) — route.ts now owns that
 * comparison, since whether a mismatch should even be checked depends on
 * whether this is a first upload or a privileged replace (section 2av),
 * a policy decision that doesn't belong inside "is this bytes blob a real
 * patch file."
 */
export function validatePatchUpload(bytes: Buffer): PatchValidationResult {
  if (bytes.length === 0) {
    return { ok: false, reason: 'Empty file.' };
  }
  if (bytes.length > MAX_PATCH_FILE_SIZE_BYTES) {
    const limitMb = (MAX_PATCH_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0);
    return { ok: false, reason: `File is larger than the ${limitMb}MB limit for patch uploads.` };
  }

  const detected = detectPatchFormat(bytes);
  if (!detected) {
    return {
      ok: false,
      reason:
        "This doesn't look like a recognized patch file (IPS/BPS/UPS/PPF/XDELTA/APS). " +
        'HackHash only stores patches, never full ROMs or ISOs — a base ROM or a finished ' +
        "romhack can't be uploaded here.",
    };
  }
  return { ok: true, detectedType: detected };
}
