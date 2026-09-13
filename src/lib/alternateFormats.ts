// src/lib/alternateFormats.ts
//
// Shared, tiny helper for the AlternateFormat feature (see the model's own
// comment in prisma/schema.prisma for the full "why"). `format` is stored
// as free text, not an enum, so this file is deliberately just a curated
// suggestion list plus a best-effort guess from a dropped file's extension
// — never a source of validation truth the way src/lib/patchTypes.ts's
// PATCH_TYPES is for the actual PatchType enum. Same "additive, not
// exhaustive" spirit as src/lib/romExtensions.ts / src/lib/languages.ts /
// src/lib/tags.ts: if a real submission needs a format this list doesn't
// know about yet, the free-text input already handles that fine — this
// list only exists to save typing for the common cases.

// Shown as quick-pick suggestions in the UI (a <datalist>, not a closed
// set) — the common disc/cart compression and container formats people
// actually distribute romhacks in, as opposed to zip/7z/rar/gzip, which are
// already handled as lossless EXTRACTION formats elsewhere (ROMProcessor.tsx
// unwraps those to get back the exact original ROM; this feature is for
// formats that can't be losslessly unwrapped in the browser today).
export const COMMON_ALTERNATE_FORMATS: readonly string[] = [
  'RVZ', 'CHD', 'CSO', 'WBFS', 'NKIT', 'GCZ', 'WIA', 'WUX', 'PBP', 'ECM',
];

// Maps a dropped file's extension to a sensible default label, purely to
// prefill the format input — never trusted as validation. Falls back to
// the raw uppercased extension for anything not in this small map (still a
// reasonable guess, e.g. a future format this list doesn't know about
// yet), and to null only when there's no extension at all to guess from.
const EXTENSION_LABEL_MAP: Readonly<Record<string, string>> = {
  rvz: 'RVZ', chd: 'CHD', cso: 'CSO', wbfs: 'WBFS', nkit: 'NKIT',
  gcz: 'GCZ', wia: 'WIA', wux: 'WUX', pbp: 'PBP', ecm: 'ECM',
};

export function guessFormatLabel(filename: string): string | null {
  const idx = filename.lastIndexOf('.');
  if (idx <= 0) return null;
  const ext = filename.slice(idx + 1).toLowerCase();
  if (!ext) return null;
  return EXTENSION_LABEL_MAP[ext] ?? ext.toUpperCase();
}
