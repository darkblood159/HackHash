// src/lib/patchStorage.ts
//
// Disk-backed storage for uploaded patch files — see POST/GET
// /api/submissions/[id]/patch. Content-addressed AND human-browsable: patches
// are filed in folders,
//
//   {PATCH_STORAGE_DIR}/{Platform}/{Base ROM}/{Hack}/{slug}__{sha1}.{ext}
//   e.g. GBA/Pokemon Emerald (USA)/Some Hack/some-hack-v2-0__3a7f9c1b...e2.bps
//
// (buildPatchRelativePath, below). sha1 is Submission.patchSha1 (already
// required and regex-validated by the caller, isValidSha1Hex in
// patchValidation.ts, before it ever reaches this file) and is the ONLY part
// that actually matters for correctness; the folders and the slug are cosmetic,
// built from Submission.platform / BaseRom.name / hackName + version purely so
// the storage directory means something at a glance when browsed directly
// (bind-mounted storage — the whole point was direct filesystem access, and a
// single folder of bare hashes defeats that).
//
// OLDER FILES: before the folder layout, every patch sat directly in the
// storage root as {sha1}__{slug}.{ext}. Those files still work — a submission
// whose patchStoredPath is NULL is looked up the old way (resolveStoredPath's
// legacy branch) — and the admin "Organize patch files" tool
// (src/lib/patchOrganize.ts) moves them into folders and fills patchStoredPath
// in. Nothing needs to be migrated for the site to keep serving them.
//
//   - No path traversal is possible by construction: a stored path is
//     re-validated (resolveRelativePath) every time it touches the
//     filesystem — relative, no "..", no hidden segments (which also keeps
//     everything out of the .incoming upload area), and it must resolve inside
//     the storage root. The sha1 is 40 validated lowercase hex chars, folder
//     names and the slug are sanitized to a safe charset before they're ever
//     allowed near a path — none is ever a raw user-supplied string.
//   - Lookups use the PERSISTED location (Submission.patchStoredPath, or the
//     legacy patchSha1 + patchStoredSlug), never a recomputed one — so a later
//     hackName / version / base-ROM edit can never make an already-stored file
//     unfindable. The location is generated fresh only at upload/re-upload
//     time (and when the admin organizer deliberately re-files a patch).
//   - Two byte-identical patches filed under the same hack/version still dedupe
//     on disk (same path); this is structural, since sha1 is in the filename.
//
// Nothing in this file ever reads or writes ROM/ISO/romhack data — patches
// only, and only the formats in PATCH_TYPES (src/lib/patchTypes.ts).

import { promises as fs, constants as fsConstants } from 'fs';
import path from 'path';
import type { PatchTypeValue } from './patchTypes';

const DEFAULT_STORAGE_DIR = path.join(process.cwd(), 'data', 'patches');
// In Docker this resolves to /app/data/patches (WORKDIR is /app) — the
// path both compose files bind-mount a user-chosen host folder onto (see
// PATCH_STORAGE_HOST_DIR in .env.docker.example) and the path the
// Dockerfile pre-creates/chowns for the non-named-volume/no-mount case.
const STORAGE_DIR = process.env.PATCH_STORAGE_DIR || DEFAULT_STORAGE_DIR;

let warnedAboutDefault = false;
function warnIfUsingDefault(): void {
  if (process.env.PATCH_STORAGE_DIR || warnedAboutDefault) return;
  warnedAboutDefault = true;
  // Deliberately a warning, not a thrown error — same "degrade, don't
  // crash" choice src/lib/rateLimit.ts makes for missing Upstash config.
  // But unlike rate limiting, there's no safe no-op here: an unset or
  // wrong PATCH_STORAGE_DIR in Docker means uploads silently land in the
  // container's writable layer and vanish on the next `docker compose up`
  // / redeploy, rather than the feature visibly not working. Loud on
  // purpose.
  console.warn(
    `[patchStorage] PATCH_STORAGE_DIR is not set — defaulting to "${DEFAULT_STORAGE_DIR}". ` +
      'In Docker this MUST point at the same path the patch-storage bind mount uses (see ' +
      'docker-compose.yml) or every uploaded patch is lost the next time the container is ' +
      'recreated. Fine for local dev without Docker; set it explicitly before going public.'
  );
}

const MAX_SLUG_LENGTH = 80;

/**
 * Builds the cosmetic, human-readable part of a stored patch's filename
 * from a hack's name + version — e.g. ("Super Mario World: Kaizo Edition",
 * "v2.0") -> "super-mario-world-kaizo-edition-v2-0". Sanitizes to a plain
 * ASCII alphanumeric-and-hyphen charset (accented letters are decomposed
 * and kept as their base letter rather than dropped, e.g. "é" -> "e";
 * everything else collapses to a single hyphen) and truncates to
 * MAX_SLUG_LENGTH, since this only ever needs to be readable at a glance,
 * not exact or complete — the sha1 alongside it is what's actually
 * authoritative. Never throws: an input that sanitizes to nothing (rare —
 * hackName is a required field — but possible for something like an
 * all-emoji title) falls back to the literal string "patch" rather than
 * producing an empty or malformed segment.
 */
export function buildPatchDisplaySlug(hackName: string, version: string): string {
  const raw = `${hackName} ${version}`;
  const slug = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining accents left by NFKD, keep the base letter
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, ''); // truncation can leave a trailing hyphen — trim it again
  return slug || 'patch';
}

// ── folder names ───────────────────────────────────────────────────────

const MAX_FOLDER_NAME_CHARS = 80;
const MAX_FOLDER_NAME_BYTES = 200; // ext4 & friends cap ONE path component at 255 bytes
export const UNKNOWN_BASE_ROM_FOLDER = 'Unknown Base ROM';
const UNTITLED_HACK_FOLDER = 'Untitled Hack';

// Windows/SMB device names (a bind-mounted storage folder is often browsed
// from a Windows machine) — "CON", "NUL", "COM1"... are unusable as a name even
// with an extension.
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * One safe, still-readable folder name from free text (a base ROM's name, a
 * hack's name). Unlike buildPatchDisplaySlug this KEEPS spaces, case,
 * parentheses and non-Latin letters, so "Pokémon Emerald (USA, Europe)" stays
 * recognizable — it only removes what can't live in a path component:
 * separators and the characters Windows/SMB forbid, control and invisible
 * direction-override characters, leading dots (hidden files, "..", and the
 * reserved ".incoming" upload area) and trailing dots/spaces (Windows silently
 * strips those). Truncated by characters AND UTF-8 bytes. Never throws, never
 * returns an empty string or "."/"..": falls back to `fallback`.
 */
export function buildFolderName(raw: string | null | undefined, fallback: string): string {
  let name = (raw ?? '')
    .normalize('NFC')
    // control characters, zero-width / bidi-override / BOM characters
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    // path separators + characters forbidden on Windows/SMB
    .replace(/[\/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  // Truncate by code points (never splitting a surrogate pair), then by bytes.
  let chars = Array.from(name).slice(0, MAX_FOLDER_NAME_CHARS);
  while (chars.length > 0 && Buffer.byteLength(chars.join(''), 'utf8') > MAX_FOLDER_NAME_BYTES) {
    chars.pop();
  }
  name = chars.join('');

  name = name.replace(/^[.\s-]+/, '').replace(/[.\s-]+$/, '');
  if (!name) return fallback;
  if (WINDOWS_RESERVED_NAME.test(name)) name = `_${name}`;
  return name;
}

export interface PatchPathInput {
  platform: string;
  /** BaseRom.name, or null/undefined for a submission with no base ROM (legacy rows). */
  baseRomName: string | null | undefined;
  hackName: string;
  version: string;
  /** Lowercase 40-hex SHA-1 of the patch file. */
  sha1: string;
  patchType: PatchTypeValue;
}

/**
 * The folder-layout location for a patch, RELATIVE to the storage root and
 * always '/'-separated (it's stored in the database and in DAT exports, so it
 * must not depend on the host OS):
 *
 *   {Platform}/{Base ROM name}/{Hack name}/{slug}__{sha1}.{ext}
 *
 * Throws only on a non-hash-shaped sha1 — everything else is sanitized.
 */
export function buildPatchRelativePath(input: PatchPathInput): string {
  if (!/^[0-9a-f]{40}$/.test(input.sha1)) {
    throw new Error(`patchStorage: refusing non-hash-shaped sha1 "${input.sha1}"`);
  }
  const platformFolder = buildFolderName(input.platform, 'OTHER');
  const baseFolder = buildFolderName(input.baseRomName, UNKNOWN_BASE_ROM_FOLDER);
  const hackFolder = buildFolderName(input.hackName, UNTITLED_HACK_FOLDER);
  const slug = buildPatchDisplaySlug(input.hackName, input.version);
  const file = `${slug}__${input.sha1}.${input.patchType.toLowerCase()}`;
  return [platformFolder, baseFolder, hackFolder, file].join('/');
}

// ── resolving locations to real paths ──────────────────────────────────

/**
 * Where a stored patch file lives, as recorded on its Submission row. Either
 * `storedPath` (folder layout, Submission.patchStoredPath) or — when that's
 * null — the legacy flat location derived from sha1 + storedSlug.
 */
export interface StoredPatchRef {
  sha1: string;
  patchType: PatchTypeValue;
  storedPath?: string | null;
  storedSlug?: string | null;
}

/**
 * Builds the StoredPatchRef for a Submission row that has a patch file
 * attached. Lowercases patchSha1 (fieldLimits.ts's regex is case-insensitive
 * and doesn't normalize) — the one place that's done for the read/delete
 * paths, so a caller can't forget it. Throws if the row has no patch identity;
 * every caller has already checked patchUploadedAt/patchSha1/patchType.
 */
export function storedPatchRef(row: {
  patchSha1: string | null;
  patchType: string | null;
  patchStoredPath?: string | null;
  patchStoredSlug?: string | null;
}): StoredPatchRef {
  if (!row.patchSha1 || !row.patchType) {
    throw new Error('patchStorage: submission has no patch hash/type recorded');
  }
  return {
    sha1: row.patchSha1.toLowerCase(),
    patchType: row.patchType as PatchTypeValue,
    storedPath: row.patchStoredPath ?? null,
    storedSlug: row.patchStoredSlug ?? null,
  };
}

const MAX_RELATIVE_PATH_CHARS = 1024;
const MAX_RELATIVE_PATH_SEGMENTS = 8;

/**
 * Turns a stored relative path into an absolute one, refusing anything that
 * could land outside the storage root or inside its hidden/temporary areas.
 * This is the function that every folder-layout filesystem call goes through —
 * so even a tampered database row, hand-edited backup or DAT import can't
 * escape the storage directory.
 */
export function resolveRelativePath(relativePath: string): string {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    relativePath.length > MAX_RELATIVE_PATH_CHARS ||
    relativePath.includes('\0') ||
    relativePath.includes('\\') ||
    relativePath.startsWith('/')
  ) {
    throw new Error('patchStorage: refusing malformed stored path');
  }
  const segments = relativePath.split('/');
  if (segments.length > MAX_RELATIVE_PATH_SEGMENTS) {
    throw new Error('patchStorage: refusing over-deep stored path');
  }
  for (const seg of segments) {
    // Empty segment ("a//b"), "." / ".." / any hidden name (also covers
    // ".incoming", where in-progress uploads live).
    if (!seg || seg.startsWith('.') || Buffer.byteLength(seg, 'utf8') > 255) {
      throw new Error('patchStorage: refusing unsafe segment in stored path');
    }
  }
  const root = path.resolve(STORAGE_DIR);
  const abs = path.resolve(root, ...segments);
  if (!abs.startsWith(root + path.sep)) {
    throw new Error('patchStorage: stored path escapes the storage directory');
  }
  return abs;
}

/** The old flat-layout file name: {sha1}__{slug}.{ext}, directly in the storage root. */
function legacyFileName(sha1: string, patchType: PatchTypeValue, displaySlug: string): string {
  return `${sha1}__${displaySlug}.${patchType.toLowerCase()}`;
}

// Exported specifically so callers that need to SHOW the exact path being
// checked (patchReconcile.ts's diagnostics, so a person can manually `ls`
// or `stat` the real file themselves rather than trust a bare "not found")
// can do so without duplicating this logic. Every other function in this
// file already routes through it.
export function resolveStoredPath(ref: StoredPatchRef): string {
  // Re-checked here (not just by the endpoint calling in) because this is
  // the function that actually touches the filesystem — the one place a
  // bug elsewhere absolutely cannot be allowed to turn into a path outside
  // STORAGE_DIR.
  if (!/^[0-9a-f]{40}$/.test(ref.sha1)) {
    throw new Error(`patchStorage: refusing non-hash-shaped sha1 "${ref.sha1}"`);
  }
  if (ref.storedPath) return resolveRelativePath(ref.storedPath);
  // Legacy flat layout. displaySlug is NOT re-sanitized here — it's expected to
  // already be buildPatchDisplaySlug's output (every writer in this codebase
  // gets it that way).
  return path.join(STORAGE_DIR, legacyFileName(ref.sha1, ref.patchType, ref.storedSlug || 'patch'));
}

/**
 * The location as a short, human-readable string relative to the storage root
 * — the stored path itself for the folder layout, just the file name for a
 * legacy one. For admin screens; never used to touch the filesystem.
 */
export function describeStoredLocation(ref: StoredPatchRef): string {
  if (ref.storedPath) return ref.storedPath;
  return legacyFileName(ref.sha1, ref.patchType, ref.storedSlug || 'patch');
}

// ── writing ────────────────────────────────────────────────────────────

/**
 * Runs `op` after making sure `dir` exists, and once more if it fails with
 * ENOENT — pruneEmptyPatchFolders (below) may remove a just-created, still
 * empty folder in the instant between the mkdir and the first write into it.
 */
async function withDir<T>(dir: string, op: () => Promise<T>): Promise<T> {
  await fs.mkdir(dir, { recursive: true });
  try {
    return await op();
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    await fs.mkdir(dir, { recursive: true });
    return op();
  }
}

export async function writePatchFile(relativePath: string, bytes: Buffer): Promise<void> {
  warnIfUsingDefault();
  const finalPath = resolveRelativePath(relativePath);
  await withDir(path.dirname(finalPath), async () => {
    // Write-then-rename: rename is atomic on the same filesystem, so a
    // request that dies mid-write (OOM, container restart, whatever) can
    // never leave a half-written file sitting at the real path for a
    // concurrent download request to serve.
    const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, bytes);
    await fs.rename(tmpPath, finalPath);
  });
}

// Exported so patchUploadSession.ts can keep in-progress chunked uploads in
// a `.incoming` subfolder of the SAME storage directory. Same directory means
// same filesystem, which is what makes movePatchFileIntoPlace's rename atomic
// (and instant, however big the file is) instead of a multi-GB copy.
export function getPatchStorageDir(): string {
  warnIfUsingDefault();
  return STORAGE_DIR;
}

/**
 * Chunked-upload counterpart of writePatchFile: instead of writing an
 * in-memory Buffer, moves an already-complete file (assembled on disk by
 * patchUploadSession.ts) to its final path. rename() is atomic on one
 * filesystem, so a concurrent download can never observe a half-written file
 * at the real path — the same guarantee writePatchFile's write-then-rename
 * gives. The source file is consumed (it no longer exists at srcPath
 * afterwards).
 *
 * srcPath must be a path this codebase produced (patchUploadSession.ts
 * builds it from a validated 32-hex session id) — like resolveRelativePath,
 * this is the function that touches the filesystem, so the destination is
 * always derived through it rather than accepted from a caller.
 */
export async function movePatchFileIntoPlace(srcPath: string, relativePath: string): Promise<void> {
  warnIfUsingDefault();
  const finalPath = resolveRelativePath(relativePath);
  await withDir(path.dirname(finalPath), async () => {
    try {
      await fs.rename(srcPath, finalPath);
    } catch (err) {
      // EXDEV = source and destination are on different filesystems (someone
      // mounted a separate volume over the incoming folder). Not expected in
      // this project's documented deployment, but degrade to a copy — still
      // finished with an atomic rename inside the destination directory —
      // rather than fail a whole multi-GB upload at the very last step.
      if ((err as NodeJS.ErrnoException)?.code !== 'EXDEV') throw err;
      const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
      await fs.copyFile(srcPath, tmpPath);
      await fs.rename(tmpPath, finalPath);
      await fs.unlink(srcPath);
    }
  });
}

// Errors that mean "this filesystem can't hard-link here" (as opposed to a real
// failure) — placeExistingPatchFile falls back to copying for these.
const NO_HARDLINK_CODES = new Set(['EPERM', 'EXDEV', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP', 'EMLINK']);

/**
 * Makes an additional name for a file that is ALREADY in patch storage, at a
 * new relative path, WITHOUT removing the original (the admin organizer
 * removes it only after the database points at the new name — so at no moment
 * is a file referenced by the database absent). A hard link when the
 * filesystem supports it (instant, no extra space, whatever the size); a copy
 * finished with an atomic rename when it doesn't. Refuses to overwrite:
 * rejects with EEXIST if something is already at the destination.
 */
export async function placeExistingPatchFile(
  srcAbs: string,
  destRelativePath: string
): Promise<{ method: 'linked' | 'copied' }> {
  const destAbs = resolveRelativePath(destRelativePath);
  return withDir(path.dirname(destAbs), async () => {
    try {
      await fs.link(srcAbs, destAbs);
      return { method: 'linked' as const };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (!code || !NO_HARDLINK_CODES.has(code)) throw err;
    }
    // No hard links on this filesystem: copy to a temp name beside the
    // destination, then rename into place (atomic). The small check-then-rename
    // gap is acceptable — this only runs from the admin-only organizer, on a
    // filesystem without hard links.
    const tmpPath = `${destAbs}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.copyFile(srcAbs, tmpPath, fsConstants.COPYFILE_EXCL);
      const occupied = await fs.access(destAbs).then(() => true, () => false);
      if (occupied) {
        const exists: NodeJS.ErrnoException = new Error(`EEXIST: ${destAbs}`);
        exists.code = 'EEXIST';
        throw exists;
      }
      await fs.rename(tmpPath, destAbs);
    } finally {
      await fs.unlink(tmpPath).catch(() => {}); // already gone after a successful rename
    }
    return { method: 'copied' as const };
  });
}

/**
 * Removes now-empty folders above a stored file's location, stopping at the
 * storage root (which is never removed). rmdir only succeeds on an EMPTY
 * directory, so this can't remove anything that still holds a file; any
 * failure just ends the walk. Best-effort tidying — never throws.
 */
export async function pruneEmptyPatchFolders(fileAbs: string): Promise<void> {
  const root = path.resolve(STORAGE_DIR);
  let dir = path.dirname(path.resolve(fileAbs));
  while (dir.startsWith(root + path.sep)) {
    try {
      await fs.rmdir(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

// ── reading / checking / deleting ──────────────────────────────────────

export async function readPatchFile(ref: StoredPatchRef): Promise<Buffer> {
  warnIfUsingDefault();
  return fs.readFile(resolveStoredPath(ref));
}

export async function patchFileExists(ref: StoredPatchRef): Promise<boolean> {
  try {
    await fs.access(resolveStoredPath(ref));
    return true;
  } catch {
    return false;
  }
}

// Like patchFileExists, but also returns the real on-disk byte size in the
// same fs call rather than requiring a second one — used anywhere that's
// about to trust/record patchFileSize (a re-import re-linking a submission
// to a patch file that survived a database rebuild; a full backup restore
// verifying an already-set patchUploadedAt still points at a real file), so
// the recorded size is always read from the actual file, never copied from
// an untrusted export. Returns null (not a thrown error) when the file
// doesn't exist — the normal, expected outcome for a submission whose patch
// was declared but never uploaded, or whose stored file genuinely didn't
// survive whatever the database lost — same "missing is a valid outcome,
// not a crash" shape as patchFileExists above.
export async function statPatchFile(ref: StoredPatchRef): Promise<{ size: number } | null> {
  try {
    const stat = await fs.stat(resolveStoredPath(ref));
    return { size: stat.size };
  } catch {
    return null;
  }
}

// Like statPatchFile, but distinguishes a genuinely-missing file from any
// OTHER filesystem error (permissions, a transient mount hiccup, too many
// concurrent handles) instead of collapsing both into the same "not there"
// result. Exists specifically for call sites where "not found" triggers a
// destructive correction (clearing a submission's patch-uploaded state) —
// for those, treating an inconclusive error as "missing" risks acting on
// bad information. patchFileExists/statPatchFile above stay as they are
// for lower-stakes callers (e.g. the detailed-DAT-reimport reattachment
// check) where "couldn't tell" and "not there" both correctly resolve to
// the same safe default of not touching anything. A stored path that fails
// validation is an 'error', never 'not-found' — a corrupt value must not be
// read as permission to clear the submission's patch state.
export type PatchFileCheckResult =
  | { status: 'found'; size: number }
  | { status: 'not-found' }
  | { status: 'error'; error: unknown };

export async function statPatchFileStrict(ref: StoredPatchRef): Promise<PatchFileCheckResult> {
  let abs: string;
  try {
    abs = resolveStoredPath(ref);
  } catch (err) {
    return { status: 'error', error: err };
  }
  try {
    const stat = await fs.stat(abs);
    return { status: 'found', size: stat.size };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { status: 'not-found' };
    return { status: 'error', error: err };
  }
}

export async function deletePatchFile(ref: StoredPatchRef): Promise<void> {
  const abs = resolveStoredPath(ref);
  try {
    await fs.unlink(abs);
  } catch (err) {
    // ENOENT (already gone) achieves the caller's goal either way — only
    // surface anything else (EACCES, etc.), which is a real problem.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }
  await pruneEmptyPatchFolders(abs);
}
