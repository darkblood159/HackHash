// src/app/api/submissions/[id]/patch/uploads/[uploadId]/complete/route.ts
//
// FINISH a chunked upload: once every byte has arrived, validate the
// assembled file and attach it to the submission. Runs exactly the same
// rules as the single-request POST /api/submissions/[id]/patch — both call
// finalizePatchUpload (src/lib/patchUploadFinalize.ts) — so the response
// shapes, status codes, messages, and the `patchTypeMismatch` field the
// client's "use the detected type" button reads are identical.
//
// What is different is only where the bytes are: on disk, not in memory. The
// magic-byte / ROM checks read a head+tail SAMPLE of the file
// (sampleFromFile), the SHA-1 is streamed in 1MB reads (sha1OfFile), and the
// file reaches its final path by rename, not a copy. Memory use is flat
// regardless of file size.
//
// On a failure that the uploader can fix WITHOUT re-sending the file (the
// declared patch type or hash on the submission doesn't match the file — the
// same fixes the single-request path offers), the session is kept and the
// response says so (`uploadKept: true`), letting the client call this
// endpoint again after correcting the metadata. When the file itself is the
// problem (not a patch, too large, empty) the session is deleted right away
// so a rejected multi-GB file doesn't sit on disk waiting for the sweeper.

import { NextRequest } from 'next/server';
import {
  finalizePatchUpload,
  jsonNoStore,
  loadAuthorizedSubmission,
  requirePatchUploadUser,
} from '@/lib/patchUploadFinalize';
import { sampleFromFile } from '@/lib/fileSample';
import { movePatchFileIntoPlace } from '@/lib/patchStorage';
import {
  deleteUploadSession,
  getReceivedBytes,
  getUploadPartPath,
  loadOwnedUploadSession,
  sha1OfFile,
  tryLockUpload,
} from '@/lib/patchUploadSession';

export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, { params }: { params: { id: string; uploadId: string } }) {
  const gate = await requirePatchUploadUser({ killSwitch: true, rateLimit: 'chunk' });
  if (!gate.ok) return gate.response;

  const meta = await loadOwnedUploadSession(params.uploadId, params.id, gate.user.id);
  if (!meta) {
    return jsonNoStore(
      { error: 'Upload session not found or expired — please start the upload again.', code: 'session-not-found' },
      404
    );
  }

  // Fresh lookup, not anything remembered from when the upload started: the
  // submission may have been approved, deleted, or given a file since. Also
  // recomputes hadPriorFile, which decides whether the declared-metadata
  // cross-checks apply.
  const auth = await loadAuthorizedSubmission(gate.user, params.id);
  if (!auth.ok) return auth.response;

  // Same lock a chunk write takes: nothing may append to (or a second finish
  // may race with) the file while it is being hashed and moved.
  const release = tryLockUpload(meta.id);
  if (!release) {
    return jsonNoStore({ error: 'This upload is already being processed.', code: 'busy' }, 409);
  }

  try {
    const received = await getReceivedBytes(meta.id);
    if (received === null) {
      await deleteUploadSession(meta.id);
      return jsonNoStore(
        { error: 'Upload session not found or expired — please start the upload again.', code: 'session-not-found' },
        404
      );
    }
    if (received !== meta.totalSize) {
      return jsonNoStore(
        { error: 'The upload is not complete yet.', code: 'incomplete', offset: received, size: meta.totalSize },
        409
      );
    }

    const partPath = getUploadPartPath(meta.id);
    const sample = await sampleFromFile(partPath);
    // Always computed fresh from the bytes on disk — never trusted from the
    // client, and never just because a value is sitting in the database.
    const sha1 = await sha1OfFile(partPath);

    const result = await finalizePatchUpload({
      submission: auth.submission,
      hadPriorFile: auth.hadPriorFile,
      user: gate.user,
      fileName: meta.fileName,
      sample,
      sha1,
      store: (dest) => movePatchFileIntoPlace(partPath, dest.relativePath),
    });

    if (result.ok) {
      await deleteUploadSession(meta.id); // the .part was renamed away; this clears the metadata
      return jsonNoStore({ success: true, submission: result.submission });
    }
    if (!result.keepUpload) await deleteUploadSession(meta.id);
    return jsonNoStore({ ...result.body, uploadKept: result.keepUpload }, result.status);
  } catch (err) {
    // Reached only by something unexpected (e.g. the database update failing
    // AFTER the file was already moved into place). Keep the session iff its
    // data file still exists, so the client knows whether a retry can work.
    console.error('[patch upload] failed to finish chunked upload:', err);
    const stillThere = (await getReceivedBytes(meta.id).catch(() => null)) !== null;
    if (!stillThere) await deleteUploadSession(meta.id).catch(() => {});
    return jsonNoStore(
      { error: 'Failed to finish the upload — please try again.', uploadKept: stillThere },
      500
    );
  } finally {
    release();
  }
}
