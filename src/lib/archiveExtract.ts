// src/lib/archiveExtract.ts
//
// Client-side (browser-only) archive reading for ROMProcessor.tsx, so a
// submitter can drop a .zip/.gz/.7z/.rar straight in instead of having to
// extract it themselves first. Everything here runs entirely in the
// browser, same as the hashing it feeds into — an archive's bytes never
// leave the client any more than a raw ROM's do.
//
// SCOPE: .zip (via jszip, already a dependency) and .gz (via the browser's
// native DecompressionStream, zero new dependency) are handled with
// lightweight, always-bundled code, below. .7z and .rar are both handled
// via 7z-wasm (a real WASM build of the actual 7-Zip/7zz codebase, not a
// from-scratch reimplementation) — see the "7-ZIP / RAR" section further
// down for the full reasoning, including the licensing question that used
// to be an open one (it isn't anymore — read that section before touching
// this). .tar/.bz2/.xz/.lzh/.lha/.cab/.z remain unsupported: rare enough
// for ROM distribution specifically that they didn't seem worth pulling in
// uninvited. See CLAUDE_HANDOFF.txt for the full reasoning if this scope
// ever needs revisiting.
//
// SAFETY: this decompresses untrusted, arbitrary-content files entirely
// in the submitter's own browser tab. The one real risk that matters here
// is a hostile/corrupt archive claiming a tiny compressed size but an
// enormous uncompressed one (a "zip bomb") hanging or crashing that tab.
// MAX_EXTRACT_BYTES below is a backstop against that — generous enough to
// never matter for a real ROM (even the largest disc-based platforms this
// project lists, PS3/Xbox 360, don't approach it), but finite.

import JSZip from 'jszip';
import { looksLikeRomFile, looksLikeKnownNonRomFile } from './romExtensions';

const MAX_EXTRACT_BYTES = 8 * 1024 * 1024 * 1024; // 8 GiB — see file header.

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

const TOO_LARGE_MESSAGE = (bytes: number) =>
  `That file is too large to extract in your browser (${formatGiB(bytes)}) — extract it on your device instead, then drop the ROM in directly.`;

// ─── Format classification ─────────────────────────────────────────────────

export type ArchiveFormat =
  | { kind: 'zip' }
  | { kind: 'gzip' }
  | { kind: 'sevenzip'; label: '7-Zip' | 'RAR' }
  | { kind: 'unsupported'; label: string }
  | { kind: 'none' };

// Checked in order, longest/most-specific suffix first — .tar.gz and .tgz
// MUST be matched before a bare ".gz" check would ever see them, or a
// tarball would get silently (and wrongly) gunzipped down to a raw .tar
// and then hashed as if that container were the ROM itself.
const UNSUPPORTED_ARCHIVE_SUFFIXES: ReadonlyArray<readonly [suffix: string, label: string]> = [
  ['.tar.gz', 'Gzipped tar (.tar.gz)'],
  ['.tgz', 'Gzipped tar (.tgz)'],
  ['.tar', 'Tar'],
  ['.bz2', 'Bzip2'],
  ['.xz', 'XZ'],
  ['.lzh', 'LZH'],
  ['.lha', 'LHA'],
  ['.cab', 'Cabinet (CAB)'],
  ['.z', 'Z (Unix compress)'],
];

export function classifyArchive(filename: string): ArchiveFormat {
  const lc = filename.toLowerCase();
  for (const [suffix, label] of UNSUPPORTED_ARCHIVE_SUFFIXES) {
    if (lc.endsWith(suffix)) return { kind: 'unsupported', label };
  }
  if (lc.endsWith('.zip')) return { kind: 'zip' };
  if (lc.endsWith('.gz')) return { kind: 'gzip' };
  if (lc.endsWith('.7z')) return { kind: 'sevenzip', label: '7-Zip' };
  if (lc.endsWith('.rar')) return { kind: 'sevenzip', label: 'RAR' };
  return { kind: 'none' };
}

// ─── ZIP ────────────────────────────────────────────────────────────────────

export interface ArchiveCandidate {
  /** Full path within the archive, e.g. "MyHack v1.0/MyHack.sfc" — shown in the picker so regional/duplicate-named variants stay distinguishable. */
  path: string;
  /** Just the filename, e.g. "MyHack.sfc" — used as the submitted filename. */
  basename: string;
  /** Uncompressed size in bytes, if known. See peekUncompressedSize() below for why this can be null. */
  size: number | null;
  looksLikeRom: boolean;
}

export type ZipReadOutcome =
  | { ok: true; candidates: ArchiveCandidate[]; extract: (path: string, onProgress?: (percent: number | null) => void) => Promise<Uint8Array> }
  | { ok: false; error: string };

function isJunkPath(path: string): boolean {
  if (path.startsWith('__MACOSX/')) return true;
  const basename = path.split('/').pop() ?? path;
  if (basename.startsWith('.')) return true; // .DS_Store and other dotfiles
  const lc = basename.toLowerCase();
  return lc === 'thumbs.db' || lc === 'desktop.ini';
}

// jszip's public JSZipObject type (see node_modules/jszip/index.d.ts) has
// no size field — the library only ever needs one internally, to size its
// own decompression buffers. It IS available before any decompression
// happens, though, via the private `_data.uncompressedSize` field.
// Verified directly against jszip@3.10.1's real shipped source (the exact
// version pinned in package.json): lib/zipObject.js sets `this._data` to
// a CompressedObject instance while loadAsync() parses the zip's central
// directory, and lib/compressedObject.js always sets `.uncompressedSize`
// on that object as a plain number, read straight from the zip's own
// central-directory metadata — no decompression involved. Treated as
// best-effort since it's a private field, not a documented guarantee: if
// a future jszip version ever removes it, `size` just becomes null and
// everything downstream (the picker UI, the size guard below) already
// handles that gracefully rather than assuming it's present.
function peekUncompressedSize(entry: JSZip.JSZipObject): number | null {
  const data = (entry as unknown as { _data?: { uncompressedSize?: unknown } })._data;
  return typeof data?.uncompressedSize === 'number' ? data.uncompressedSize : null;
}

export async function readZipCandidates(file: File): Promise<ZipReadOutcome> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (/encrypted/i.test(message)) {
      return { ok: false, error: 'This ZIP is password-protected — extract it on your device first, then drop the ROM in directly.' };
    }
    return { ok: false, error: "Couldn't read this ZIP — it may be corrupted. Try extracting it on your device, then drop the ROM in directly." };
  }

  const candidates: ArchiveCandidate[] = [];
  zip.forEach((relativePath, entry) => {
    if (entry.dir || isJunkPath(relativePath)) return;
    const size = peekUncompressedSize(entry);
    if (size === 0) return; // empty file, never a real ROM
    candidates.push({
      path: relativePath,
      basename: relativePath.split('/').pop() || relativePath,
      size,
      looksLikeRom: looksLikeRomFile(relativePath),
    });
  });

  if (candidates.length === 0) {
    return { ok: false, error: "This ZIP doesn't seem to contain any files — nothing to hash." };
  }

  const extract = async (path: string, onProgress?: (percent: number) => void): Promise<Uint8Array> => {
    const entry = zip.file(path);
    if (!entry) throw new Error('That file is no longer in the archive.');
    const size = peekUncompressedSize(entry);
    if (size !== null && size > MAX_EXTRACT_BYTES) {
      throw new Error(TOO_LARGE_MESSAGE(size));
    }
    return entry.async('uint8array', (meta) => onProgress?.(meta.percent));
  };

  return { ok: true, candidates, extract };
}

// Decides whether a candidate list is unambiguous enough to hash without
// asking. Three tiers, most confident first:
//  1. Exactly one file matches a known ROM extension (the common case —
//     a ROM plus a readme/patch/cover image alongside it).
//  2. Nothing matches a known ROM extension, but exactly one file also
//     doesn't match a KNOWN NON-rom extension either (an unfamiliar or
//     platform-specific extension this project's list doesn't have yet,
//     still sitting next to an obvious readme/doc — the readme is
//     recognizable even when the ROM itself isn't).
//  3. Exactly one real file in the archive, period — nothing else it
//     could be, regardless of what it's named.
// Anything less certain than that returns null, and the caller should
// ask the submitter to pick instead of guessing.
export function pickAutoCandidate(candidates: ArchiveCandidate[]): ArchiveCandidate | null {
  const romMatches = candidates.filter((c) => c.looksLikeRom);
  if (romMatches.length === 1) return romMatches[0];

  if (romMatches.length === 0) {
    const notObviouslyNonRom = candidates.filter((c) => !looksLikeKnownNonRomFile(c.basename));
    if (notObviouslyNonRom.length === 1) return notObviouslyNonRom[0];
  }

  return candidates.length === 1 ? candidates[0] : null;
}

// ─── GZIP ───────────────────────────────────────────────────────────────────
//
// Plain .gz is a single compressed stream, not a multi-file archive like
// zip — there's no entry list, so no picker is ever needed here, only a
// straight decompress. The inner filename is derived by stripping ".gz"
// (matching what command-line gunzip does by default) rather than reading
// gzip's optional embedded-filename header field, which real encoders
// often leave unset — a predictable "strip .gz" beats an unreliable
// maybe-present original name.

export type GzipReadOutcome =
  | { ok: true; innerName: string; bytes: Uint8Array }
  | { ok: false; error: string };

export async function readGzipFile(file: File): Promise<GzipReadOutcome> {
  if (typeof DecompressionStream === 'undefined') {
    return { ok: false, error: "Your browser doesn't support decompressing GZIP files — please extract it on your device, then drop the ROM in directly." };
  }

  try {
    const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    // Read incrementally rather than buffering via a single Response.blob()
    // call, specifically so a bomb-style .gz (tiny on disk, enormous once
    // decompressed) gets caught and aborted mid-stream instead of first
    // growing unbounded in memory — gzip has no upfront central-directory
    // equivalent to check a size against before starting, unlike zip above.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_EXTRACT_BYTES) {
        reader.cancel().catch(() => {});
        return { ok: false, error: TOO_LARGE_MESSAGE(total) };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, innerName: stripGzExtension(file.name), bytes };
  } catch {
    return { ok: false, error: "Couldn't decompress this GZIP file — it may be corrupted. Try extracting it on your device, then drop the ROM in directly." };
  }
}

function stripGzExtension(filename: string): string {
  return /\.gz$/i.test(filename) ? filename.slice(0, -3) : filename;
}

// ─── 7-ZIP / RAR (via 7z-wasm) ──────────────────────────────────────────────
//
// Both formats route through the same real 7-Zip codebase (compiled to
// WASM by the 7z-wasm package — an actual build of 7-Zip's own sources,
// not a from-scratch reimplementation), since 7-Zip has always been able
// to READ (not write) RAR archives internally. One dependency, one code
// path, for both.
//
// LICENSING — this used to be an open question (see CHANGELOG.md's
// original archive-support entry); it isn't anymore. 7z-wasm's wasm/js
// files are "GNU LGPL + unRAR restriction" — read directly from
// node_modules/7z-wasm/License.txt and unRarLicense.txt after installing
// the exact pinned version, not taken from general claims about UnRAR
// licensing found elsewhere. The unRAR-derived portion's restriction is
// specifically "cannot be used to re-create the RAR compression
// algorithm" / "develop a RAR (WinRAR) compatible archiver" —
// decompression-only use, which is all this file ever does, is explicitly
// permitted "without limitations, free of charge," with only a notice-
// preservation requirement (keep the license text alongside the code,
// which npm/the repo already does by shipping License.txt/
// unRarLicense.txt with the package). Whatever license HackHash itself
// eventually picks (still an open pre-release item — see
// CLAUDE_HANDOFF.txt), keep those two files around: LGPL is a copyleft
// license, so it does have real terms of its own, but "depend on an LGPL
// library as an ordinary, unmodified npm package" is exactly the standard
// case LGPL was written to accommodate without forcing the consuming
// project to also become LGPL.
//
// WEIGHT: the WASM binary alone is ~1.65MB before any HTTP compression —
// roughly the size of every other archive-handling dependency in this
// file put together, times several. Loaded via a dynamic import() INSIDE
// read7zCandidates() below, never a top-level import, specifically so a
// zip/gzip/direct-ROM submitter — most submitters — never fetches any of
// it. Verified this actually produces a separate chunk under this
// project's real bundler rather than trusting the dynamic-import syntax
// alone to guarantee that on its own — see CLAUDE_HANDOFF.txt for how.
//
// BEHAVIOR VERIFIED DIRECTLY, not assumed — real 7z-wasm, real fixtures,
// in this sandbox (full session in CLAUDE_HANDOFF.txt):
//  - callMain() does NOT hang waiting on a password prompt even with no
//    stdin available at all (the real browser situation) — it throws,
//    safely, well under a second. A hang here would freeze the tab, so
//    this specifically was tested rather than hoped.
//  - A corrupt/non-archive file does NOT throw at all — callMain()
//    returns normally. The only reliable failure signal for that case is
//    the captured stdout/stderr text, checked below. Both a thrown
//    exception AND specific text patterns are treated as failure —
//    neither signal alone covers every real failure mode observed.
//  - Multiple callMain() calls against the same module instance (list,
//    then later extract) work correctly — the module instance is kept
//    alive in the closure below rather than recreated per call, avoiding
//    redundant WASM setup + a redundant archive-bytes write for every
//    extract() after the first list.
//
// Listing uses `l -slt` (7-Zip's machine-parseable "technical information"
// mode) rather than the default human-readable table — stable
// "Key = Value" blocks per entry, directories distinguishable from files
// via the Attributes field's leading "D", the entries section itself
// starting after a literal "----------" line that separates it from the
// archive-level header block above it.
//
// No granular progress is available from callMain() the way jszip and the
// gzip path above expose (no percent-complete callback of any kind exists
// in this library) — extract()'s onProgress here only ever reports either
// null (in progress, no known percent — distinct from 0, which would
// falsely imply a real, known starting point) or 100 on completion, never
// a real intermediate number. ROMProcessor.tsx renders a null percent as
// an indeterminate state rather than a specific (and fabricated) position.

const SEVENZIP_ENTRY_SEPARATOR = '\n----------\n';

function parseSevenZipListing(output: string): ArchiveCandidate[] {
  const sepIdx = output.indexOf(SEVENZIP_ENTRY_SEPARATOR);
  if (sepIdx === -1) return [];
  const entriesText = output.slice(sepIdx + SEVENZIP_ENTRY_SEPARATOR.length);
  const candidates: ArchiveCandidate[] = [];
  for (const rawBlock of entriesText.split(/\n\n+/)) {
    const block = rawBlock.trim();
    if (!block) continue;
    const fields: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const eq = line.indexOf(' = ');
      if (eq === -1) continue;
      fields[line.slice(0, eq).trim()] = line.slice(eq + 3);
    }
    if (!fields.Path) continue;
    if (/^D/.test(fields.Attributes ?? '')) continue; // directory entry, not a file
    // RAR archives built on Windows can embed backslash-separated paths;
    // 7z's own listing has always shown forward slashes in testing here,
    // but normalizing defensively costs nothing and this specific case
    // couldn't be verified against a real .rar fixture (see
    // CLAUDE_HANDOFF.txt for why — nothing can create one to test against
    // freely, only WinRAR itself can, by design).
    const path = fields.Path.replace(/\\/g, '/');
    if (isJunkPath(path)) continue;
    const sizeNum = fields.Size ? parseInt(fields.Size, 10) : NaN;
    if (Number.isFinite(sizeNum) && sizeNum === 0) continue; // empty file, never a real ROM — same rule as the zip path above
    candidates.push({
      path,
      basename: path.split('/').pop() || path,
      size: Number.isFinite(sizeNum) ? sizeNum : null,
      looksLikeRom: looksLikeRomFile(path.split('/').pop() || path),
    });
  }
  return candidates;
}

function sevenZipFailureMessage(output: string, formatLabel: string): string | null {
  if (/Enter password/i.test(output)) {
    return `This ${formatLabel} archive is password-protected — extract it on your device first, then drop the ROM in directly.`;
  }
  if (/Cannot open the file as|Is not archive|^ERRORS:/im.test(output)) {
    return `Couldn't read this ${formatLabel} archive — it may be corrupted. Try extracting it on your device, then drop the ROM in directly.`;
  }
  return null;
}

export type SevenZipReadOutcome =
  | { ok: true; candidates: ArchiveCandidate[]; extract: (path: string, onProgress?: (percent: number | null) => void) => Promise<Uint8Array> }
  | { ok: false; error: string };

export async function read7zCandidates(file: File, formatLabel: '7-Zip' | 'RAR'): Promise<SevenZipReadOutcome> {
  if (file.size > MAX_EXTRACT_BYTES) {
    return { ok: false, error: TOO_LARGE_MESSAGE(file.size) };
  }

  // The only place 7z-wasm's WASM binary gets fetched — see the WEIGHT
  // note above. Both the module (via the bundler's own import cache) and
  // the underlying .wasm bytes (via the browser's normal HTTP cache) stay
  // available after this resolves once, so a submitter who tries more
  // than one .7z/.rar in a session only pays the fetch cost the first time.
  let SevenZipFactory: (opts?: Record<string, unknown>) => Promise<{
    FS: { writeFile(path: string, data: Uint8Array): void; readFile(path: string): Uint8Array; mkdir(path: string): void };
    callMain(args: string[]): void;
  }>;
  try {
    SevenZipFactory = (await import('7z-wasm')).default;
  } catch {
    return { ok: false, error: "Couldn't load the archive reader — check your connection and try again, or extract this archive on your device instead." };
  }

  let output = '';
  const appendChar = (c: number | null) => { if (c !== null) output += String.fromCharCode(c); };
  let sevenZip: Awaited<ReturnType<typeof SevenZipFactory>>;
  try {
    sevenZip = await SevenZipFactory({
      stdin: () => null, // no interactive input exists in a browser tab — verified this fails safely rather than hanging, see the note above
      stdout: appendChar,
      stderr: appendChar,
      quit: () => {}, // never let anything in this module tear down the page — verified the default handler doesn't either, but not relying on that holding true in every environment
      noExitRuntime: true,
    });
  } catch {
    return { ok: false, error: "Couldn't start the archive reader — please try again, or extract this archive on your device instead." };
  }

  const archivePath = formatLabel === 'RAR' ? '/archive.rar' : '/archive.7z';
  const bytes = new Uint8Array(await file.arrayBuffer());
  sevenZip.FS.writeFile(archivePath, bytes);

  output = '';
  try {
    sevenZip.callMain(['l', '-slt', archivePath]);
  } catch {
    // Falls through to the text-based failure check below — a thrown
    // exception here (the password-prompt case, confirmed by testing)
    // still leaves useful text in `output` captured via the callbacks
    // above, which is the more specific signal either way.
  }

  const listFailure = sevenZipFailureMessage(output, formatLabel);
  if (listFailure) return { ok: false, error: listFailure };

  const candidates = parseSevenZipListing(output);
  if (candidates.length === 0) {
    return { ok: false, error: `This ${formatLabel} archive doesn't seem to contain any files — nothing to hash.` };
  }

  const extract = async (path: string, onProgress?: (percent: number | null) => void): Promise<Uint8Array> => {
    onProgress?.(null); // no real percentage available from this library — see the file-header note
    const outDir = '/out';
    try {
      sevenZip.FS.mkdir(outDir);
    } catch {
      // Already exists from a previous extract() call on this same
      // instance — expected and fine, the instance is deliberately reused
      // rather than recreated (see the BEHAVIOR VERIFIED note above).
    }
    output = '';
    try {
      sevenZip.callMain(['e', archivePath, '-o' + outDir, path, '-y']);
    } catch {
      // Same reasoning as the listing step above — checked via output text next.
    }
    const extractFailure = sevenZipFailureMessage(output, formatLabel);
    if (extractFailure) throw new Error(extractFailure);
    const basename = path.split('/').pop() || path;
    try {
      const result = sevenZip.FS.readFile(outDir + '/' + basename);
      onProgress?.(100);
      return result;
    } catch {
      throw new Error(`Couldn't extract that file from the archive — please try again, or extract it on your device instead.`);
    }
  };

  return { ok: true, candidates, extract };
}
