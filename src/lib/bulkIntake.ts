// src/lib/bulkIntake.ts
//
// Turns what the person dropped on the bulk screen into individual Files
// ready to hash — ROMs or patches — opening zip / 7z / RAR / gz archives in
// the browser along the way. Built ON archiveExtract.ts's primitives
// (classifyArchive, readZipCandidates, read7zCandidates, readGzipFile): it
// does not re-implement any archive reading, only the "take EVERY matching
// file" policy bulk needs. The single-file screens (ROMProcessor,
// PatchFileUpload) instead ask the person to pick one file from an archive;
// here an archive holding several versions is the normal case, so every
// match becomes a row.
//
// Nothing here ever leaves the browser.

import {
  classifyArchive,
  readZipCandidates,
  read7zCandidates,
  readGzipFile,
  pickAutoCandidate,
  pickAutoPatchCandidate,
  type ArchiveCandidate,
} from './archiveExtract';
import { looksLikeKnownNonRomFile } from './romExtensions';
import { patchTypeFromFilename } from './patchTypes';

export type IntakeKind = 'rom' | 'patch';

export interface IntakeResult {
  files: File[];
  /** Plain-language things the person should know (skipped files, failures). */
  notes: string[];
}

// Guards the TOTAL pulled out of archives in one drop. Each extraction is
// already individually capped inside archiveExtract.ts; this stops a big
// multi-version archive from holding several of those in memory at once.
const MAX_TOTAL_EXTRACT_BYTES = 1.5 * 1024 * 1024 * 1024;

function wrap(bytes: Uint8Array, name: string, lastModified: number): File {
  // Same construction ROMProcessor.tsx / PatchFileUpload.tsx use.
  return new File([new Uint8Array(bytes)], name, { lastModified });
}

function selectFromArchive(kind: IntakeKind, candidates: ArchiveCandidate[]): ArchiveCandidate[] {
  const matching = candidates.filter((c) => (kind === 'rom' ? c.looksLikeRom : patchTypeFromFilename(c.basename) !== null));
  if (matching.length > 0) return matching;
  // Nothing matched by extension: fall back to the single-file screens' own
  // rule — exactly one plausible file is taken, anything less certain isn't.
  const only = kind === 'rom' ? pickAutoCandidate(candidates) : pickAutoPatchCandidate(candidates);
  return only ? [only] : [];
}

export async function expandDropped(file: File, kind: IntakeKind): Promise<IntakeResult> {
  const out: IntakeResult = { files: [], notes: [] };
  const what = kind === 'rom' ? 'ROM' : 'patch';
  const format = classifyArchive(file.name);

  if (format.kind === 'unsupported') {
    out.notes.push(`${file.name}: ${format.label} archives can't be opened in your browser — extract it on your device and drop the ${what} files in directly.`);
    return out;
  }

  if (format.kind === 'gzip') {
    const result = await readGzipFile(file);
    if (!result.ok) out.notes.push(`${file.name}: ${result.error}`);
    else out.files.push(wrap(result.bytes, result.innerName, file.lastModified));
    return out;
  }

  if (format.kind === 'zip' || format.kind === 'sevenzip') {
    const outcome = format.kind === 'zip' ? await readZipCandidates(file) : await read7zCandidates(file, format.label);
    if (!outcome.ok) {
      out.notes.push(`${file.name}: ${outcome.error}`);
      return out;
    }
    const chosen = selectFromArchive(kind, outcome.candidates);
    if (chosen.length === 0) {
      out.notes.push(`${file.name}: no ${what} files found inside.`);
      return out;
    }
    let total = 0;
    for (const c of chosen) {
      total += c.size ?? 0;
      if (total > MAX_TOTAL_EXTRACT_BYTES) {
        out.notes.push(`${file.name}: too much to open at once — opened ${out.files.length} of ${chosen.length} files. Drop the rest separately.`);
        break;
      }
      try {
        out.files.push(wrap(await outcome.extract(c.path), c.basename, file.lastModified));
      } catch (err) {
        out.notes.push(`${file.name} › ${c.basename}: ${err instanceof Error ? err.message : "couldn't be extracted"}`);
      }
    }
    return out;
  }

  // A plain file. A ROM drop accepts anything that isn't obviously a
  // readme/manual/image (the person picked it on purpose, and ROM extensions
  // are open-ended); a patch drop needs a recognised patch extension.
  if (kind === 'rom') {
    if (looksLikeKnownNonRomFile(file.name)) out.notes.push(`${file.name}: skipped — that doesn't look like a ROM.`);
    else out.files.push(file);
  } else if (patchTypeFromFilename(file.name) === null) {
    out.notes.push(`${file.name}: skipped — not a recognised patch type (.ips, .bps, .ups, .xdelta, .ppf, .aps).`);
  } else {
    out.files.push(file);
  }
  return out;
}
