// src/lib/patchUploadSession.ts
//
// Server side of the chunked/resumable patch upload — see
// patchUploadChunking.ts for why it exists (Cloudflare's per-request body
// cap) and the routes under /api/submissions/[id]/patch/uploads for the HTTP
// surface. This file owns everything that touches the filesystem.
//
// MODEL: a session is two files in {PATCH_STORAGE_DIR}/.incoming/:
//   {id}.part  the bytes received so far, append-only
//   {id}.json  who started it and what they declared (userId, submissionId,
//              fileName, totalSize, createdAt)
// The received offset is NOT stored anywhere — it is simply the .part file's
// size on disk. That makes it impossible for a stored offset to disagree
// with the data, survives a crash or container restart with nothing to
// reconcile, and means "resume" is just "ask the server how big the file
// is". No database table, no migration.
//
// APPEND-ONLY, ORDERED: a chunk is accepted only if its declared offset
// equals the current file size. Anything else gets the real offset back and
// the client resyncs. Concurrent writers to one session are refused (busy)
// by an in-process lock — this app runs as a single Node process (one
// container), the same assumption the sync scheduler already makes; the lock
// lives on globalThis so every route bundle sees the same one.
//
// NOTHING here decides whether the finished file is an acceptable patch —
// that stays in patchValidation.ts, run by patchUploadFinalize.ts against a
// head/tail sample of the assembled file. This file only moves bytes safely.
//
// SESSION IDs are 128 random bits (32 hex chars), regex-validated before any
// path is built from them, so a request can never turn one into a path
// outside .incoming — same "validate before it touches a path" rule
// resolveStoredPath (patchStorage.ts) applies to hashes.

import crypto from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import path from 'path';
import { getPatchStorageDir } from './patchStorage';

export const UPLOAD_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// A session that has an .part XOR .json (a crash between creating the two)
// is cleaned up on a much shorter fuse than a real, possibly-paused upload.
const ORPHAN_GRACE_MS = 60 * 60 * 1000;
export const MAX_ACTIVE_UPLOADS_PER_USER = 2;
// Refuse to START an upload the disk can't hold, with headroom left over.
// Best-effort (statfs isn't available everywhere) — see assertFreeSpace.
const FREE_SPACE_MARGIN_BYTES = 256 * 1024 * 1024;

const DEFAULT_CHUNK_BYTES = 50 * 1024 * 1024;
const MIN_CONFIGURABLE_CHUNK_BYTES = 1024 * 1024;
const MAX_CONFIGURABLE_CHUNK_BYTES = 512 * 1024 * 1024;

/**
 * The largest chunk the server accepts, and the size it tells clients to
 * start with. Default 50MB — half of Cloudflare's 100MB Free/Pro per-request
 * cap, leaving generous headroom for headers/overhead and a slow uplink's
 * per-request duration. Anyone not behind Cloudflare (or on a higher tier)
 * can raise it with PATCH_UPLOAD_CHUNK_BYTES; anyone whose proxy caps
 * requests lower must lower it. Clamped to a sane range either way.
 */
export function getChunkSizeBytes(): number {
  const raw = process.env.PATCH_UPLOAD_CHUNK_BYTES;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CHUNK_BYTES;
  return Math.min(MAX_CONFIGURABLE_CHUNK_BYTES, Math.max(MIN_CONFIGURABLE_CHUNK_BYTES, parsed));
}

const SESSION_ID_RE = /^[0-9a-f]{32}$/;

export function isValidUploadId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

function incomingDir(): string {
  return path.join(getPatchStorageDir(), '.incoming');
}

function requireValidId(id: string): string {
  if (!isValidUploadId(id)) throw new Error(`patchUploadSession: refusing malformed upload id "${id}"`);
  return id;
}

export function getUploadPartPath(id: string): string {
  return path.join(incomingDir(), `${requireValidId(id)}.part`);
}

function metaPath(id: string): string {
  return path.join(incomingDir(), `${requireValidId(id)}.json`);
}

export interface UploadSessionMeta {
  id: string;
  userId: string;
  submissionId: string;
  fileName: string;
  totalSize: number;
  createdAt: number;
}

export class TooManyUploadSessionsError extends Error {
  constructor(public readonly active: number) {
    super(`too many in-progress uploads (${active})`);
  }
}

export class InsufficientStorageError extends Error {}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

// ── in-process lock ────────────────────────────────────────────────────

const lockHolder = globalThis as unknown as { __hackhashUploadLocks?: Set<string> };
const locks: Set<string> = (lockHolder.__hackhashUploadLocks ??= new Set<string>());

/** Returns a release function, or null if this session is already being written/finalized. */
export function tryLockUpload(id: string): (() => void) | null {
  if (locks.has(id)) return null;
  locks.add(id);
  return () => {
    locks.delete(id);
  };
}

// ── session lifecycle ──────────────────────────────────────────────────

async function assertFreeSpace(dir: string, needed: number): Promise<void> {
  let free: number;
  try {
    const st = await fs.statfs(dir);
    free = Number(st.bavail) * Number(st.bsize);
  } catch {
    return; // statfs unsupported/unavailable here — skip the pre-check, don't block uploads on it
  }
  if (Number.isFinite(free) && free < needed + FREE_SPACE_MARGIN_BYTES) {
    throw new InsufficientStorageError('not enough free disk space for this upload');
  }
}

export async function loadUploadSession(id: string): Promise<UploadSessionMeta | null> {
  if (!isValidUploadId(id)) return null;
  let raw: string;
  try {
    raw = await fs.readFile(metaPath(id), 'utf8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<UploadSessionMeta>;
    if (
      parsed.id !== id ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.submissionId !== 'string' ||
      typeof parsed.fileName !== 'string' ||
      typeof parsed.totalSize !== 'number' ||
      typeof parsed.createdAt !== 'number'
    ) {
      return null;
    }
    return parsed as UploadSessionMeta;
  } catch {
    return null; // corrupt metadata — treat as no session; the sweeper will clear the leftovers
  }
}

/**
 * loadUploadSession plus the ownership check every request needs: the session
 * must belong to THIS user and THIS submission. A mismatch is reported as
 * "not found" (null), never "forbidden", so probing another user's session id
 * confirms nothing about whether it exists.
 */
export async function loadOwnedUploadSession(
  id: string,
  submissionId: string,
  userId: string
): Promise<UploadSessionMeta | null> {
  const meta = await loadUploadSession(id);
  if (!meta || meta.userId !== userId || meta.submissionId !== submissionId) return null;
  return meta;
}

async function listSessions(): Promise<UploadSessionMeta[]> {
  let names: string[];
  try {
    names = await fs.readdir(incomingDir());
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const out: UploadSessionMeta[] = [];
  for (const name of names) {
    const m = /^([0-9a-f]{32})\.json$/.exec(name);
    if (!m) continue;
    const meta = await loadUploadSession(m[1]);
    if (meta) out.push(meta);
  }
  return out;
}

export async function createUploadSession(input: {
  userId: string;
  submissionId: string;
  fileName: string;
  totalSize: number;
}): Promise<UploadSessionMeta> {
  const dir = incomingDir();
  await fs.mkdir(dir, { recursive: true });

  // Opportunistic cleanup instead of a scheduler: abandoned uploads are only
  // ever created by starting one, so this is the natural place to reap them.
  await sweepStaleUploads().catch((err) => {
    console.error('[patch upload] stale-session sweep failed (continuing):', err);
  });

  const active = (await listSessions()).filter((s) => s.userId === input.userId).length;
  if (active >= MAX_ACTIVE_UPLOADS_PER_USER) throw new TooManyUploadSessionsError(active);

  await assertFreeSpace(dir, input.totalSize);

  const id = crypto.randomBytes(16).toString('hex');
  const meta: UploadSessionMeta = { id, ...input, createdAt: Date.now() };
  // .part first: a crash between the two files leaves an orphan .part (the
  // sweeper removes it), never a .json describing data that doesn't exist.
  const handle = await fs.open(getUploadPartPath(id), 'wx');
  await handle.close();
  await fs.writeFile(metaPath(id), JSON.stringify(meta), { flag: 'wx' });
  return meta;
}

/** Bytes received so far (= the .part file's size), or null if the data file is gone. */
export async function getReceivedBytes(id: string): Promise<number | null> {
  try {
    return (await fs.stat(getUploadPartPath(id))).size;
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

export async function deleteUploadSession(id: string): Promise<void> {
  if (!isValidUploadId(id)) return;
  for (const p of [getUploadPartPath(id), metaPath(id)]) {
    try {
      await fs.unlink(p);
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
  }
}

/**
 * Deletes sessions with no activity for UPLOAD_SESSION_MAX_AGE_MS (activity =
 * the newest mtime of the two files; every appended chunk bumps the .part's).
 * Never touches a session that is currently locked (mid-chunk or mid-finish).
 * Returns how many sessions were removed.
 */
export async function sweepStaleUploads(now: number = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(incomingDir());
  } catch (err) {
    if (isEnoent(err)) return 0;
    throw err;
  }
  const ids = new Set<string>();
  for (const name of names) {
    const m = /^([0-9a-f]{32})\.(part|json)$/.exec(name);
    if (m) ids.add(m[1]);
  }
  let removed = 0;
  for (const id of Array.from(ids)) {
    if (locks.has(id)) continue;
    const mtimes: number[] = [];
    for (const p of [getUploadPartPath(id), metaPath(id)]) {
      try {
        mtimes.push((await fs.stat(p)).mtimeMs);
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
    }
    if (mtimes.length === 0) continue;
    const orphan = mtimes.length < 2;
    const idleFor = now - Math.max(...mtimes);
    if (idleFor > (orphan ? ORPHAN_GRACE_MS : UPLOAD_SESSION_MAX_AGE_MS)) {
      await deleteUploadSession(id);
      removed++;
    }
  }
  return removed;
}

// ── receiving bytes ────────────────────────────────────────────────────

export type AppendResult =
  | { ok: true; offset: number }
  | {
      ok: false;
      reason: 'busy' | 'offset-mismatch' | 'too-large' | 'empty' | 'not-found' | 'aborted' | 'storage-error';
      /** The session's true received offset, when known — the client resyncs to this. */
      offset?: number;
    };

/**
 * Appends one chunk's bytes to the session's .part file, streaming straight
 * to disk (memory use is one network read at a time, not the chunk size).
 *
 * `expectedOffset` is where the client believes the file currently ends;
 * anything else is refused with the real offset. `maxBytes` caps this one
 * chunk (the server's chunk size). The total can never exceed the size
 * declared at start, whatever the client sends. `expectedLength` is the
 * request's Content-Length when it had one — a body that ends short of it is
 * a dropped connection, not a finished chunk.
 *
 * Partial data from a dropped connection is KEPT: bytes are written strictly
 * in order from expectedOffset, so whatever landed is a valid prefix, and the
 * client's resume simply continues from the new (larger) offset. The one
 * case that rolls back is too-large, which discards the whole request.
 */
export async function appendChunk(
  meta: UploadSessionMeta,
  expectedOffset: number,
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  expectedLength: number | null
): Promise<AppendResult> {
  const release = tryLockUpload(meta.id);
  if (!release) {
    return { ok: false, reason: 'busy', offset: (await getReceivedBytes(meta.id)) ?? undefined };
  }
  try {
    const size = await getReceivedBytes(meta.id);
    if (size === null) return { ok: false, reason: 'not-found' };
    if (size !== expectedOffset) return { ok: false, reason: 'offset-mismatch', offset: size };
    if (!body) return { ok: false, reason: 'empty', offset: size };

    const allowed = Math.min(maxBytes, meta.totalSize - size);
    if (allowed <= 0) return { ok: false, reason: 'too-large', offset: size };

    const handle = await fs.open(getUploadPartPath(meta.id), 'r+');
    const reader = body.getReader();
    let written = 0;
    try {
      for (;;) {
        let step: ReadableStreamReadResult<Uint8Array>;
        try {
          step = await reader.read();
        } catch {
          return { ok: false, reason: 'aborted', offset: size + written };
        }
        if (step.done) break;
        const value = step.value;
        if (written + value.byteLength > allowed) {
          await reader.cancel().catch(() => {});
          await handle.truncate(size); // discard this whole request's bytes
          return { ok: false, reason: 'too-large', offset: size };
        }
        let done = 0;
        while (done < value.byteLength) {
          const { bytesWritten } = await handle.write(value, done, value.byteLength - done, size + written + done);
          done += bytesWritten;
        }
        written += value.byteLength;
      }
    } catch (err) {
      console.error('[patch upload] failed writing chunk to disk:', err);
      return { ok: false, reason: 'storage-error', offset: size + written };
    } finally {
      await handle.close().catch(() => {});
    }

    if (written === 0) return { ok: false, reason: 'empty', offset: size };
    if (expectedLength !== null && written !== expectedLength) {
      return { ok: false, reason: 'aborted', offset: size + written };
    }
    return { ok: true, offset: size + written };
  } finally {
    release();
  }
}

/** SHA-1 of a file on disk, streamed in 1MB reads — memory stays flat for any size. */
export async function sha1OfFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha1');
  for await (const chunk of createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex'); // lowercase, same as the legacy route's digest('hex')
}
