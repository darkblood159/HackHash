// src/lib/patchTypes.ts
//
// Single source of truth for the six patch formats this project recognizes
// — mirrors the Prisma PatchType enum (prisma/schema.prisma) exactly.
// Previously a hand-copied local `const PATCH_TYPES = [...]` in BOTH
// SubmitForm.tsx and ChangeRequestSection.tsx (ChangeRequestSection's own
// comment at the time: "no existing shared home for it"). Centralizing now
// because patchTypeFromFilename() below needs the same six values anyway —
// this file becomes that shared home. SubmitForm.tsx has been switched to
// import PATCH_TYPES from here as part of this change.
// ChangeRequestSection.tsx's own copy is UNTOUCHED for now — it's not part
// of the drag-and-drop feature this file exists for, and there's a second
// Claude session working in this codebase concurrently, so this round
// deliberately keeps its edits scoped to only the files the actual feature
// needs. Worth pointing ChangeRequestSection.tsx at this same file later.
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

export const PATCH_TYPES = ['IPS', 'BPS', 'UPS', 'XDELTA', 'PPF', 'APS'] as const;
export type PatchTypeValue = (typeof PATCH_TYPES)[number];

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
