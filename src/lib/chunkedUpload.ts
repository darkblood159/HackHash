// src/lib/chunkedUpload.ts
//
// Browser side of the chunked/resumable patch upload. Used by
// PatchFileUpload.tsx for files over CHUNKED_UPLOAD_THRESHOLD_BYTES; the
// server side is /api/submissions/[id]/patch/uploads (protocol summary in
// that folder's route.ts, storage model in patchUploadSession.ts).
//
// CLIENT-SAFE: imports only patchUploadChunking.ts (no imports of its own).
//
// THE SERVER IS THE SOURCE OF TRUTH FOR PROGRESS. The client never assumes a
// chunk landed because it sent it; after every failure it asks the server how
// many bytes it really has and continues from there. That one rule is what
// makes retries, page refreshes and dropped connections safe — there is no
// client-side bookkeeping that can disagree with the file on disk.
//
// RETRIES: network errors, timeouts and 5xx (including Cloudflare's 52x) are
// retried with backoff; after repeated failures the chunk size halves (down
// to MIN_CHUNK_BYTES), which is what saves a slow or flaky uplink — a
// smaller request finishes before whatever is dropping it does. 4xx errors
// are the server saying no, not a flaky network, and fail immediately.
//
// RESUME ACROSS A REFRESH: the session id is remembered per submission (in
// localStorage, falling back to memory when storage is unavailable) together
// with a fingerprint of the file (name + size + lastModified). Picking the
// same file again continues where it stopped instead of starting over.
//
// TWO THINGS THIS DELIBERATELY DOES NOT DO: hash the file in the browser
// (WebCrypto can only hash a whole in-memory buffer, which is exactly what
// breaks on multi-GB files; the server computes the SHA-1 as it stores the
// file), and send a per-chunk checksum (TLS already protects each request in
// flight; the assembled file's SHA-1 is computed server-side — flagged in the
// handoff as optional hardening).

import { MIN_CHUNK_BYTES, UPLOAD_OFFSET_HEADER } from './patchUploadChunking';

export interface ChunkedUploadProgress {
  /** Bytes the server has confirmed plus the in-flight chunk's bytes sent so far. */
  sent: number;
  total: number;
}

export type ChunkedUploadResult =
  | { ok: true; data: Record<string, unknown> }
  | {
      ok: false;
      /** HTTP status of the failing response; 0 = no response (network) or cancelled. */
      status: number;
      data: Record<string, unknown>;
      message: string;
      cancelled?: boolean;
      /**
       * The finish call's outcome could not be determined (connection or
       * gateway died while the server may still have been processing). The
       * caller should refresh page state rather than claim success or failure.
       */
      uncertain?: boolean;
    };

export interface ChunkedUploadOptions {
  submissionId: string;
  file: File;
  onProgress?: (progress: ChunkedUploadProgress) => void;
  signal?: AbortSignal;
}

const MAX_CONSECUTIVE_FAILURES = 6;
const MAX_RESYNCS = 25; // 409 offset corrections tolerated in one upload before giving up
const MAX_BACKOFF_MS = 30_000;
const BUSY_RETRY_MS = 1_500;
// A single chunk that takes longer than this is treated as failed and retried
// smaller. Generous — the point is to bound a hung connection, not to police
// slow uplinks (those are helped by the halving, not by this number).
const CHUNK_TIMEOUT_MS = 10 * 60 * 1000;
const COMPLETE_UNCERTAIN_RETRIES = 3;

// ── remembered session (resume across refresh) ─────────────────────────

interface SavedUpload {
  uploadId: string;
  fileName: string;
  size: number;
  lastModified: number;
}

const memoryStore = new Map<string, SavedUpload>();
const storageKey = (submissionId: string) => `hackhash:patchUpload:${submissionId}`;

function loadSaved(submissionId: string): SavedUpload | null {
  try {
    const raw = window.localStorage.getItem(storageKey(submissionId));
    if (raw) {
      const p = JSON.parse(raw) as Partial<SavedUpload>;
      if (
        typeof p.uploadId === 'string' &&
        typeof p.fileName === 'string' &&
        typeof p.size === 'number' &&
        typeof p.lastModified === 'number'
      ) {
        return p as SavedUpload;
      }
    }
  } catch {
    /* storage unavailable or corrupt — fall through to memory */
  }
  return memoryStore.get(submissionId) ?? null;
}

function saveSaved(submissionId: string, value: SavedUpload): void {
  memoryStore.set(submissionId, value);
  try {
    window.localStorage.setItem(storageKey(submissionId), JSON.stringify(value));
  } catch {
    /* private mode / quota — the in-memory copy still covers retry-without-refresh */
  }
}

function clearSaved(submissionId: string): void {
  memoryStore.delete(submissionId);
  try {
    window.localStorage.removeItem(storageKey(submissionId));
  } catch {
    /* nothing to do */
  }
}

// ── HTTP helpers ───────────────────────────────────────────────────────

interface HttpResult {
  /** 0 when there was no HTTP response at all. */
  status: number;
  data: Record<string, unknown>;
  aborted?: boolean;
}

async function jsonRequest(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  body: unknown,
  signal?: AbortSignal
): Promise<HttpResult> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      cache: 'no-store',
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, data };
  } catch {
    return { status: 0, data: {}, aborted: signal?.aborted === true };
  }
}

// XMLHttpRequest rather than fetch for the chunk itself: fetch cannot report
// upload progress, and a 50MB chunk on a slow uplink with a frozen progress
// bar for minutes looks exactly like a hang.
function sendChunk(
  url: string,
  blob: Blob,
  offset: number,
  onLoaded: (loaded: number) => void,
  signal?: AbortSignal
): Promise<HttpResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ status: 0, data: {}, aborted: true });
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('PATCH', url);
    xhr.setRequestHeader(UPLOAD_OFFSET_HEADER, String(offset));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.timeout = CHUNK_TIMEOUT_MS;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onLoaded(e.loaded);
    };
    xhr.onload = () => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        /* non-JSON body (e.g. a Cloudflare error page) — status alone is what matters */
      }
      resolve({ status: xhr.status, data });
    };
    xhr.onerror = () => resolve({ status: 0, data: {} });
    xhr.ontimeout = () => resolve({ status: 0, data: {} });
    xhr.onabort = () => resolve({ status: 0, data: {}, aborted: true });
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true }
    );
  });
}

const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function fail(res: HttpResult, fallback: string): ChunkedUploadResult {
  return { ok: false, status: res.status, data: res.data, message: asString(res.data.error) ?? fallback };
}

const CANCELLED: ChunkedUploadResult = {
  ok: false,
  status: 0,
  data: {},
  message: 'Upload cancelled.',
  cancelled: true,
};

// ── public API ─────────────────────────────────────────────────────────

/**
 * Uploads `file` in chunks and finishes it. Resolves (never rejects) with
 * either the finish call's JSON body (`{ success, submission }`, same shape
 * as the single-request upload) or a failure the caller can show.
 */
export async function uploadFileChunked(opts: ChunkedUploadOptions): Promise<ChunkedUploadResult> {
  const { submissionId, file, onProgress, signal } = opts;
  const base = `/api/submissions/${submissionId}/patch/uploads`;
  const total = file.size;
  const report = (sent: number) => onProgress?.({ sent: Math.min(sent, total), total });

  let uploadId: string | null = null;
  let offset = 0;
  let chunkSize = 0;

  // 1. Resume a remembered session for this exact file, if the server still has it.
  const saved = loadSaved(submissionId);
  const sameFile =
    saved !== null &&
    saved.fileName === file.name &&
    saved.size === file.size &&
    saved.lastModified === file.lastModified;
  if (saved && sameFile) {
    const st = await jsonRequest('GET', `${base}/${saved.uploadId}`, undefined, signal);
    if (signal?.aborted) return CANCELLED;
    const serverOffset = asNumber(st.data.offset);
    if (st.status === 200 && serverOffset !== null && asNumber(st.data.size) === total) {
      uploadId = saved.uploadId;
      offset = serverOffset;
      chunkSize = asNumber(st.data.chunkSize) ?? 0;
    } else if (st.status === 0) {
      return fail(st, "Couldn't reach the server — please check your connection and try again.");
    } else {
      clearSaved(submissionId); // gone/expired/foreign — start fresh below
    }
  } else if (saved) {
    // A different file is being uploaded now: free the abandoned session's
    // disk (best effort — the server also sweeps idle ones after 24 hours).
    void jsonRequest('DELETE', `${base}/${saved.uploadId}`, undefined);
    clearSaved(submissionId);
  }

  // 2. Otherwise start a new session.
  if (uploadId === null) {
    // Deliberately NOT given `signal`. If the user cancels while this request
    // is in flight, the server may already have created the session; aborting
    // the fetch would leave a session whose id we never learn — impossible to
    // delete, and it counts toward the per-user cap of open uploads until the
    // 24-hour sweep (two quick cancels could block uploading for a day). The
    // request is tiny, so let it finish and clean up if the user cancelled.
    const started = await jsonRequest('POST', base, { fileName: file.name, size: total });
    const newId = asString(started.data.uploadId);
    if (signal?.aborted) {
      if (started.status === 201 && newId !== null) {
        await jsonRequest('DELETE', `${base}/${newId}`, undefined);
      }
      return CANCELLED;
    }
    if (started.status !== 201 || newId === null) {
      return fail(
        started,
        started.status === 0
          ? "Couldn't reach the server — please check your connection and try again."
          : 'Could not start the upload — please try again.'
      );
    }
    uploadId = newId;
    chunkSize = asNumber(started.data.chunkSize) ?? 0;
    offset = 0;
    saveSaved(submissionId, { uploadId, fileName: file.name, size: total, lastModified: file.lastModified });
  }
  if (chunkSize <= 0) chunkSize = MIN_CHUNK_BYTES;
  const sessionUrl = `${base}/${uploadId}`;

  // 3. Send chunks until the server has every byte.
  let currentChunk = chunkSize;
  let failures = 0;
  let resyncs = 0;
  report(offset);

  while (offset < total) {
    if (signal?.aborted) return CANCELLED;

    const end = Math.min(offset + currentChunk, total);
    const from = offset;
    const res = await sendChunk(sessionUrl, file.slice(from, end), from, (loaded) => report(from + loaded), signal);
    if (res.aborted || signal?.aborted) return CANCELLED;

    if (res.status === 200) {
      const next = asNumber(res.data.offset);
      if (next === null || next <= from) {
        return fail(res, 'The server returned an unexpected upload state — please try again.');
      }
      offset = next;
      failures = 0;
      report(offset);
      continue;
    }

    if (res.status === 409) {
      // The server's offset differs from ours (or it is still writing a
      // previous attempt). Adopt its number and continue.
      if (++resyncs > MAX_RESYNCS) return fail(res, 'Upload got out of sync — please try again.');
      const serverOffset = asNumber(res.data.offset);
      if (serverOffset !== null) {
        offset = serverOffset;
        report(offset);
      }
      if (res.data.code === 'busy') await sleep(BUSY_RETRY_MS, signal);
      continue;
    }

    if (res.status === 404) {
      clearSaved(submissionId);
      return fail(res, 'The upload expired on the server — please try again.');
    }

    // The admin kill switch answers 503 like a gateway hiccup would, but it is
    // a deliberate refusal with its own message — retrying cannot help and
    // "the connection kept dropping" would be actively misleading.
    if (res.data.uploadsDisabled === true) {
      return fail(res, 'Uploads are temporarily disabled.');
    }
    const retryable = res.status === 0 || res.status >= 500;
    if (!retryable) {
      // 400/401/403/413/429/…: the server refused. Not a flaky network, so
      // retrying the same request cannot help.
      return fail(res, 'Upload failed — please try again.');
    }

    // Retryable: back off, shrink the chunk after repeated failures, then
    // ask the server where it actually is before sending anything again.
    failures++;
    if (failures > MAX_CONSECUTIVE_FAILURES) {
      return {
        ok: false,
        status: res.status,
        data: res.data,
        message:
          'The connection kept dropping, so the upload was paused. Pick the same file again to ' +
          'continue from where it stopped.',
      };
    }
    if (failures >= 2) currentChunk = Math.max(MIN_CHUNK_BYTES, Math.floor(currentChunk / 2));
    await sleep(Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (failures - 1)), signal);
    if (signal?.aborted) return CANCELLED;
    const st = await jsonRequest('GET', sessionUrl, undefined, signal);
    if (signal?.aborted) return CANCELLED;
    if (st.status === 404) {
      clearSaved(submissionId);
      return fail(st, 'The upload expired on the server — please try again.');
    }
    const serverOffset = asNumber(st.data.offset);
    if (st.status === 200 && serverOffset !== null) offset = serverOffset;
    // any other outcome (still offline): loop and let the next chunk attempt count as the next failure
  }

  // 4. Finish: the server validates the assembled file and attaches it.
  let sawAmbiguousFailure = false;
  for (let attempt = 0; attempt <= COMPLETE_UNCERTAIN_RETRIES; attempt++) {
    const done = await jsonRequest('POST', `${sessionUrl}/complete`, undefined, signal);
    if (signal?.aborted) return CANCELLED;

    if (done.status === 200) {
      clearSaved(submissionId);
      return { ok: true, data: done.data };
    }

    if (done.data.uploadsDisabled === true) {
      return fail(done, 'Uploads are temporarily disabled.'); // deliberate refusal, not a flaky gateway
    }

    // No response, or a gateway/server error: the server may have finished
    // (or still be finishing) a large file even though this call never heard
    // back — e.g. Cloudflare gives up waiting after ~100s. Retrying is safe
    // (finishing is idempotent-by-lock); a 404 after such a failure most
    // likely means the first attempt actually succeeded.
    const ambiguous = done.status === 0 || done.status >= 500;
    if (ambiguous && done.status !== 500) {
      sawAmbiguousFailure = true;
      await sleep(3_000, signal);
      continue;
    }
    if (done.status === 409 && done.data.code === 'busy') {
      sawAmbiguousFailure = true; // the earlier attempt is still processing
      await sleep(BUSY_RETRY_MS * 2, signal);
      continue;
    }
    if (done.status === 404 && sawAmbiguousFailure) {
      clearSaved(submissionId);
      return {
        ok: false,
        status: 404,
        data: done.data,
        uncertain: true,
        message: 'The upload may have finished processing on the server — refreshing to check.',
      };
    }

    // A definite answer from the server. Forget the session unless it says it
    // is keeping the bytes for a retry (declared type/hash mismatch, or a
    // transient storage error) — see complete/route.ts.
    if (done.data.uploadKept !== true) clearSaved(submissionId);
    return fail(done, 'Upload failed — please try again.');
  }
  return {
    ok: false,
    status: 0,
    data: {},
    uncertain: true,
    message: 'The server is taking a long time to finish this upload — refreshing to check.',
  };
}

/** Abandons the remembered upload for a submission (frees the server's disk) and forgets it. Best effort, never throws. */
export async function discardSavedUpload(submissionId: string): Promise<void> {
  const saved = loadSaved(submissionId);
  clearSaved(submissionId);
  if (!saved) return;
  await jsonRequest('DELETE', `/api/submissions/${submissionId}/patch/uploads/${saved.uploadId}`, undefined);
}
