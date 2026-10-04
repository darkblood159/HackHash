// src/app/api/submissions/[id]/patch/uploads/[uploadId]/route.ts
//
// GET (how much has the server got?), PATCH (append one chunk), DELETE
// (abandon) for one chunked-upload session. Protocol overview in
// ../route.ts; storage model in src/lib/patchUploadSession.ts.
//
// EVERY handler requires the session to belong to the calling user AND to
// the submission id in the URL, and answers "not found" for anything else —
// a session id is a capability, but it is never the ONLY thing checked.

import { NextRequest } from 'next/server';
import { jsonNoStore, loadAuthorizedSubmission, requirePatchUploadUser } from '@/lib/patchUploadFinalize';
import { UPLOAD_OFFSET_HEADER } from '@/lib/patchUploadChunking';
import {
  appendChunk,
  deleteUploadSession,
  getChunkSizeBytes,
  getReceivedBytes,
  loadOwnedUploadSession,
} from '@/lib/patchUploadSession';

export const dynamic = 'force-dynamic';

const NOT_FOUND_BODY = {
  error: 'Upload session not found or expired — please start the upload again.',
  code: 'session-not-found',
};

type Ctx = { params: { id: string; uploadId: string } };

// Resume: "how many bytes do you have?" The answer is the .part file's real
// size, so it is correct after a dropped connection, a page refresh, or a
// server restart with nothing to reconcile.
export async function GET(_req: NextRequest, { params }: Ctx) {
  const gate = await requirePatchUploadUser({ killSwitch: false, rateLimit: 'chunk' });
  if (!gate.ok) return gate.response;

  const meta = await loadOwnedUploadSession(params.uploadId, params.id, gate.user.id);
  if (!meta) return jsonNoStore(NOT_FOUND_BODY, 404);
  const offset = await getReceivedBytes(meta.id);
  if (offset === null) {
    await deleteUploadSession(meta.id); // metadata with no data — nothing resumable, tidy up
    return jsonNoStore(NOT_FOUND_BODY, 404);
  }
  return jsonNoStore({ offset, size: meta.totalSize, chunkSize: getChunkSizeBytes() });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const gate = await requirePatchUploadUser({ killSwitch: true, rateLimit: 'chunk' });
  if (!gate.ok) return gate.response;

  const meta = await loadOwnedUploadSession(params.uploadId, params.id, gate.user.id);
  if (!meta) return jsonNoStore(NOT_FOUND_BODY, 404);

  // Re-checked on EVERY chunk, not just at start: the submission can be
  // approved, deleted, or have a file attached by someone else while a slow
  // upload is in flight, and a session must not outlive the permission that
  // opened it. One indexed primary-key lookup per (tens-of-MB) chunk.
  const auth = await loadAuthorizedSubmission(gate.user, params.id);
  if (!auth.ok) return auth.response;

  const offsetHeader = req.headers.get(UPLOAD_OFFSET_HEADER);
  if (offsetHeader === null || !/^\d{1,16}$/.test(offsetHeader)) {
    return jsonNoStore({ error: `Missing or invalid ${UPLOAD_OFFSET_HEADER} header.` }, 400);
  }
  const offset = Number.parseInt(offsetHeader, 10);

  const chunkSize = getChunkSizeBytes();
  const lengthHeader = req.headers.get('content-length');
  let contentLength: number | null = null;
  if (lengthHeader !== null) {
    contentLength = Number.parseInt(lengthHeader, 10);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      return jsonNoStore({ error: 'Invalid Content-Length.' }, 400);
    }
    // Cheap early rejection before a single body byte is read. Content-Length
    // can be absent (chunked transfer-encoding), so this is a fast path only;
    // appendChunk enforces the same cap on the bytes actually received.
    if (contentLength > chunkSize) {
      return jsonNoStore(
        { error: `Chunk is larger than the ${chunkSize}-byte limit.`, code: 'chunk-too-large', chunkSize },
        413
      );
    }
    if (contentLength === 0) {
      return jsonNoStore({ error: 'Empty chunk.' }, 400);
    }
  }

  const result = await appendChunk(meta, offset, req.body, chunkSize, contentLength);
  if (result.ok) {
    return jsonNoStore({ offset: result.offset, size: meta.totalSize });
  }
  switch (result.reason) {
    case 'offset-mismatch':
      return jsonNoStore(
        { error: 'Chunk offset does not match the server — resync and continue.', code: 'offset-mismatch', offset: result.offset },
        409
      );
    case 'busy':
      return jsonNoStore(
        { error: 'The previous chunk is still being written — retry shortly.', code: 'busy', offset: result.offset },
        409
      );
    case 'too-large':
      return jsonNoStore(
        { error: 'Chunk would exceed the size declared for this upload.', code: 'chunk-too-large', offset: result.offset, chunkSize },
        413
      );
    case 'empty':
      return jsonNoStore({ error: 'Empty chunk.', offset: result.offset }, 400);
    case 'not-found':
      return jsonNoStore(NOT_FOUND_BODY, 404);
    case 'aborted':
      // The connection dropped mid-chunk. Whatever arrived was kept (it is a
      // valid prefix) — `offset` is the new true size for the client's resync,
      // though a client that is really gone will never read this.
      return jsonNoStore({ error: 'Upload interrupted.', code: 'interrupted', offset: result.offset }, 400);
    case 'storage-error':
    default:
      return jsonNoStore({ error: 'The server could not store that chunk — please retry.', offset: result.offset }, 500);
  }
}

// Idempotent on purpose: abandoning an upload that is already gone (or was
// never yours) is a success from the caller's point of view, so a client
// cleaning up after itself never has to interpret a 404.
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const gate = await requirePatchUploadUser({ killSwitch: false, rateLimit: 'chunk' });
  if (!gate.ok) return gate.response;

  const meta = await loadOwnedUploadSession(params.uploadId, params.id, gate.user.id);
  if (meta) await deleteUploadSession(meta.id);
  return jsonNoStore({ success: true });
}
