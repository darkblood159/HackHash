// src/lib/patchTypes.ts
//
// Single source of truth for the patch formats this project recognizes —
// mirrors the Prisma PatchType enum (prisma/schema.prisma) exactly. Six
// are real, byte-detectable formats (see patchValidation.ts's
// detectPatchFormat); the seventh, OTHER, is a deliberate catch-all for a
// real patch tool this project doesn't have a byte signature for (added
// after a real request — Kingdom Hearts-modding patches were the concrete
// example — for uncommon formats generally, not that one specifically).
// Previously a hand-copied local `const PATCH_TYPES = [...]` in BOTH
// SubmitForm.tsx and ChangeRequestSection.tsx (ChangeRequestSection's own
// comment at the time: "no existing shared home for it"). Centralizing now
// because patchTypeFromFilename() below needs the same values anyway —
// this file becomes that shared home. SubmitForm.tsx and
// ChangeRequestSection.tsx both import PATCH_TYPES from here now (the
// latter's own copy was left un-consolidated for one round while a second
// Claude session was concurrently working in this codebase — see git
// history — and finished here once that was no longer a concern).
//
// Deliberately does NOT import anything from src/lib/romExtensions.ts, even
// though that file's KNOWN_NON_ROM_EXTENSIONS already happens to list these
// exact six extensions (for an unrelated reason — excluding patches from
// ROM auto-detection inside archives). Kept fully independent on purpose:
// romExtensions.ts backs the archive-extraction pipeline, which is that
// same concurrent session's actual work area — not worth coupling this new,
// unrelated feature to a file that's live-edited elsewhere right now. The
// two lists already agree; worth reconciling into one only once both
// sessions' changes have actually landed.

export const PATCH_TYPES = ['IPS', 'BPS', 'UPS', 'XDELTA', 'PPF', 'APS', 'OTHER'] as const;
export type PatchTypeValue = (typeof PATCH_TYPES)[number];

// Every dropdown that lists PATCH_TYPES renders each value as its own
// label — fine for the five real acronyms (IPS/BPS/UPS/PPF/APS read
// naturally in caps) and XDELTA, but 'OTHER' in full caps reads like an
// error state rather than a normal option. This is the one place that
// distinction is made, so every dropdown shows the same thing.
// Widened to plain `string` rather than PatchTypeValue on purpose — some
// callers (PatchFileUpload.tsx's PatchTypeMismatch, an echo of a value
// that's already been validated server-side) deliberately don't carry the
// narrower type themselves, and this function's only real job is "is this
// literally the string 'OTHER'," which needs nothing more specific than
// that to be correct.
export function patchTypeLabel(type: string): string {
  return type === 'OTHER' ? 'Other' : type;
}

// xdelta patches occasionally carry '.vcdiff' instead of '.xdelta' — VCDIFF
// is the underlying format's actual RFC name, and some tools default to it.
// Both map to the same XDELTA enum value; everything else is a direct 1:1
// with PATCH_TYPES above.
const PATCH_EXTENSION_MAP: Readonly<Record<string, PatchTypeValue>> = {
  ips: 'IPS',
  bps: 'BPS',
  ups: 'UPS',
  xdelta: 'XDELTA',
  vcdiff: 'XDELTA',
  ppf: 'PPF',
  aps: 'APS',
};

// Returns null for an unrecognized extension rather than guessing — same
// "uncertain means don't guess, let the person decide" rule
// archiveExtract.ts's pickAutoCandidate follows for ROM auto-pick. The
// caller (PatchDropzone) leaves the Patch type dropdown exactly as it was
// when this returns null, rather than forcing it to something that might
// be wrong.
export function patchTypeFromFilename(filename: string): PatchTypeValue | null {
  const idx = filename.lastIndexOf('.');
  if (idx <= 0) return null;
  const ext = filename.slice(idx + 1).toLowerCase();
  return PATCH_EXTENSION_MAP[ext] ?? null;
}

// Thrown by sha1Hex specifically for the one failure mode worth telling
// the person apart from any other: crypto.subtle simply doesn't exist
// outside a "secure context" (HTTPS, or localhost — that one's carved out
// as an exception specifically for local development). A self-hosted app
// tested by hitting the container directly (a bare LAN IP or a plain
// http:// URL, before or without the reverse proxy terminating TLS in
// front of it) hits this every time, and crypto.subtle.digest(...) throws
// on `undefined`, not with any message describing why. Callers should
// show `.message` verbatim for this one; it's already written for a
// person to read, not a log.
export class HashingUnavailableError extends Error {}

// PatchDropzone.tsx and the newer PatchFileUpload.tsx each had their own
// near-identical copy of this exact function, both wrapped in a bare
// `catch { setError("Couldn't read that file...") }` with no way to tell
// "this browser genuinely can't do this here" apart from any other
// failure — which is exactly the bug report that led to consolidating
// them here instead of just patching the message in one of the two
// places and leaving the other's copy to rot with the same gap. One
// implementation now; both components import it.
export async function sha1Hex(file: File): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new HashingUnavailableError(
      "This page isn't loaded over a secure connection, so the browser won't allow hashing " +
        'files here. This works over HTTPS, or over plain http://localhost during local ' +
        "development — but not over a bare IP address or hostname without HTTPS, which is a " +
        'common way to end up testing a self-hosted app directly against the container, ' +
        'ahead of (or bypassing) whatever normally terminates TLS in front of it.'
    );
  }
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
