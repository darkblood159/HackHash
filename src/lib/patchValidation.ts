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
import { looksLikeKnownRom } from './romDetection';

// Raised twice now: 64MB -> 1GB after the first report that modern
// disc-based total-conversion patches can legitimately run into the
// hundreds of MB; then 1GB -> 2GB on a direct follow-up request. Kingdom
// Hearts modding was the concrete example both times. PATCH_MAX_UPLOAD_BYTES
// below still overrides this for anyone who needs more than 2GB too.
//
// IMPORTANT — raising this alone may not be enough: a reverse proxy in
// front of this app (Nginx Proxy Manager, in this project's own documented
// deployment — see DOCKER_PORTAINER_GUIDE.md) commonly has its own,
// separate upload-size cap (`client_max_body_size`, defaulting to 1MB)
// that rejects an oversized request BEFORE it ever reaches this
// application-level check at all. If a large upload still fails after
// raising PATCH_MAX_UPLOAD_BYTES, that proxy setting is the next thing to
// check — this app has no way to detect or work around a limit enforced
// in front of it.
const DEFAULT_MAX_PATCH_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB
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
 *
 * `declaredType` is the ONE exception to "doesn't compare against a
 * declared type" above: when it's specifically 'OTHER', a buffer that
 * doesn't match any of the six known signatures is accepted rather than
 * rejected — see the OTHER branch below for why — UNLESS it matches a
 * known ROM/disc-image signature instead (romDetection.ts), in which case
 * it's rejected regardless of what was declared. Any other declared value
 * (or none at all) leaves the original all-or-nothing behavior completely
 * unchanged.
 */
export function validatePatchUpload(
  bytes: Buffer,
  declaredType?: PatchTypeValue | null
): PatchValidationResult {
  if (bytes.length === 0) {
    return { ok: false, reason: 'Empty file.' };
  }
  if (bytes.length > MAX_PATCH_FILE_SIZE_BYTES) {
    const limitMb = (MAX_PATCH_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0);
    return { ok: false, reason: `File is larger than the ${limitMb}MB limit for patch uploads.` };
  }

  const detected = detectPatchFormat(bytes);
  if (detected) {
    // Always trust real byte detection over a stale/wrong declaration,
    // 'OTHER' included — if someone declared OTHER but the bytes turn out
    // to actually be a known format, that's exactly what route.ts's own
    // existing declared-vs-detected mismatch check (a separate, later
    // concern) is for; it already offers a one-click "use the detected
    // type instead" fix, so nothing extra is needed here.
    return { ok: true, detectedType: detected };
  }

  // Nothing matched a known format's magic bytes. Ordinarily that's a
  // hard rejection — the message below — but an explicit 'OTHER'
  // declaration is exactly the escape hatch for a real patch tool this
  // project doesn't (yet) have a byte signature for, so it's honored
  // rather than treated the same as an unrecognized/garbage upload,
  // SUBJECT TO the ROM/disc-image check right below — 'OTHER' is an
  // escape hatch for an uncommon PATCH, not a way to bypass "no ROMs or
  // ISOs" entirely. (Note: by the time bytes reach this function at all,
  // route.ts has already decided whether this caller is even ALLOWED to
  // use 'OTHER' — see isPrivilegedPatchRole, patchPermissions.ts. A
  // non-privileged caller's declaredType is never 'OTHER' here even if
  // they set that on the submission; that's the real, load-bearing
  // control. This ROM check is the second, automatic layer on top of it,
  // not a substitute for it.)
  if (declaredType === 'OTHER') {
    const romCheck = looksLikeKnownRom(bytes);
    if (romCheck.looksLikeRom) {
      return {
        ok: false,
        reason:
          `This looks like ${romCheck.matchedFormat}, not a patch. HackHash only stores ` +
          'patches, never full ROMs or ISOs — that\'s still true under "Other."',
      };
    }
    return { ok: true, detectedType: 'OTHER' };
  }

  return {
    ok: false,
    reason:
      "This doesn't look like a recognized patch file (IPS/BPS/UPS/PPF/XDELTA/APS). If this is " +
      'a real patch in a format HackHash doesn\'t know how to detect yet, set the patch type to ' +
      '"Other" first, then upload again. Otherwise: HackHash only stores patches, never full ' +
      "ROMs or ISOs — a base ROM or a finished romhack can't be uploaded here.",
  };
}
