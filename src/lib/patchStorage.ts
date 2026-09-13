// src/lib/patchStorage.ts
//
// Disk-backed storage for uploaded patch files — see POST/GET
// /api/submissions/[id]/patch. Content-addressed AND human-browsable: every
// patch is stored as {sha1}__{slug}.{ext}, e.g.
// 3a7f9c1b...e2.__super-mario-world-kaizo-edition-v2.bps — sha1 is
// Submission.patchSha1 (already required and already regex-validated by
// the caller, isValidSha1Hex in patchValidation.ts, before it ever reaches
// this file) and is the ONLY part that actually matters for correctness;
// slug is cosmetic, built from Submission.hackName + version
// (buildPatchDisplaySlug, below) purely so the folder means something at a
// glance when browsed directly on disk — see CLAUDE_HANDOFF.txt section
// 2au for why (short version: bind-mounted storage, the whole point was
// direct filesystem access, and a folder of bare hashes defeats that).
//   - No path traversal is possible by construction: sha1 is 40 validated
//     lowercase hex chars, and the slug is independently sanitized to a
//     safe charset (buildPatchDisplaySlug) before it's ever allowed near a
//     path — neither is ever a raw user-supplied string.
//   - Lookups are ALWAYS by sha1, never by slug — the exact slug used gets
//     persisted (Submission.patchStoredSlug) at upload time and passed
//     back in on every read, specifically so a later hackName/version edit
//     can never cause an already-stored file to become unfindable. The
//     slug is regenerated fresh only at upload/re-upload time.
//   - Two byte-identical patches still dedupe on disk (same sha1 -> same
//     filename) even with different slugs — this can't happen in practice
//     today, since sha1 already has to match the declared hack's patch
//     metadata, but the property still holds structurally.
//
// Nothing in this file ever reads or writes ROM/ISO/romhack data — patches
// only, and only the six formats in PATCH_TYPES (src/lib/patchTypes.ts).

import { promises as fs } from 'fs';
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

function resolveStoredPath(sha1: string, patchType: PatchTypeValue, displaySlug: string): string {
  // Re-checked here (not just by the endpoint calling in) because this is
  // the function that actually touches the filesystem — the one place a
  // bug elsewhere absolutely cannot be allowed to turn into a path outside
  // STORAGE_DIR. displaySlug is NOT re-sanitized here — it's expected to
  // already be buildPatchDisplaySlug's output (every caller in this
  // codebase gets it that way), and re-running an idempotent sanitizer
  // would be redundant rather than unsafe either way.
  if (!/^[0-9a-f]{40}$/.test(sha1)) {
    throw new Error(`patchStorage: refusing non-hash-shaped sha1 "${sha1}"`);
  }
  return path.join(STORAGE_DIR, `${sha1}__${displaySlug}.${patchType.toLowerCase()}`);
}

export async function writePatchFile(
  sha1: string,
  patchType: PatchTypeValue,
  displaySlug: string,
  bytes: Buffer
): Promise<void> {
  warnIfUsingDefault();
  await fs.mkdir(STORAGE_DIR, { recursive: true });
  const finalPath = resolveStoredPath(sha1, patchType, displaySlug);
  // Write-then-rename: rename is atomic on the same filesystem, so a
  // request that dies mid-write (OOM, container restart, whatever) can
  // never leave a half-written file sitting at the real path for a
  // concurrent download request to serve.
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, bytes);
  await fs.rename(tmpPath, finalPath);
}

export async function readPatchFile(
  sha1: string,
  patchType: PatchTypeValue,
  displaySlug: string
): Promise<Buffer> {
  warnIfUsingDefault();
  return fs.readFile(resolveStoredPath(sha1, patchType, displaySlug));
}

export async function patchFileExists(
  sha1: string,
  patchType: PatchTypeValue,
  displaySlug: string
): Promise<boolean> {
  try {
    await fs.access(resolveStoredPath(sha1, patchType, displaySlug));
    return true;
  } catch {
    return false;
  }
}

export async function deletePatchFile(
  sha1: string,
  patchType: PatchTypeValue,
  displaySlug: string
): Promise<void> {
  try {
    await fs.unlink(resolveStoredPath(sha1, patchType, displaySlug));
  } catch (err) {
    // ENOENT (already gone) achieves the caller's goal either way — only
    // surface anything else (EACCES, etc.), which is a real problem.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }
}
