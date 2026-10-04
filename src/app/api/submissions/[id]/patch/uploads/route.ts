// src/app/api/submissions/[id]/patch/uploads/route.ts
//
// START of a chunked/resumable patch upload. Exists because Cloudflare caps
// a single proxied request body (100MB on Free/Pro), so a big patch has to
// arrive as many small requests — see src/lib/patchUploadChunking.ts for the
// why and src/lib/patchUploadSession.ts for how a session is stored.
//
// The whole protocol (every route returns no-store JSON):
//   POST   .../patch/uploads                    this file: declare fileName +
//                                               size, get { uploadId, chunkSize }
//   GET    .../patch/uploads/{id}               { offset } — how much the server
//                                               has (this is what "resume" is)
//   PATCH  .../patch/uploads/{id}               body = raw bytes, header
//                                               X-Upload-Offset = where they start
//   POST   .../patch/uploads/{id}/complete      validate + store, exactly the
//                                               checks the single-request POST does
//   DELETE .../patch/uploads/{id}               abandon and free the disk
//
// Nothing about the FILE is trusted or validated here beyond its declared
// size — this only opens a session. Every rule that decides whether the
// bytes are an acceptable patch runs at /complete (patchUploadFinalize.ts,
// shared with the single-request path); the permission rule
// (canManagePatchFile) runs here, on every chunk, and again at /complete.

import { NextRequest } from 'next/server';
import { jsonNoStore, loadAuthorizedSubmission, requirePatchUploadUser } from '@/lib/patchUploadFinalize';
import { MAX_PATCH_FILE_SIZE_BYTES } from '@/lib/patchValidation';
import {
  createUploadSession,
  getChunkSizeBytes,
  InsufficientStorageError,
  MAX_ACTIVE_UPLOADS_PER_USER,
  TooManyUploadSessionsError,
} from '@/lib/patchUploadSession';

export const dynamic = 'force-dynamic';

// Matches patchFilename's own cap in fieldLimits.ts. Real filenames are
// <=255 bytes on every mainstream filesystem, so this only ever rejects a
// hand-crafted request.
const MAX_FILENAME_LENGTH = 500;

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requirePatchUploadUser({ killSwitch: true, rateLimit: 'start' });
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonNoStore({ error: 'Expected a JSON body with "fileName" and "size".' }, 400);
  }
  const { fileName, size } = (body ?? {}) as { fileName?: unknown; size?: unknown };
  if (typeof fileName !== 'string' || fileName.length === 0 || fileName.length > MAX_FILENAME_LENGTH) {
    return jsonNoStore({ error: '"fileName" must be a non-empty string.' }, 400);
  }
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    return jsonNoStore({ error: '"size" must be a whole number of bytes.' }, 400);
  }

  const auth = await loadAuthorizedSubmission(gate.user, params.id);
  if (!auth.ok) return auth.response;

  if (size === 0) {
    // Same message validatePatchSample gives an empty file on the other path.
    return jsonNoStore({ error: 'Empty file.' }, 422);
  }
  if (size > MAX_PATCH_FILE_SIZE_BYTES) {
    const limitMb = (MAX_PATCH_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0);
    return jsonNoStore({ error: `File is larger than the ${limitMb}MB limit for patch uploads.` }, 413);
  }

  try {
    const meta = await createUploadSession({
      userId: gate.user.id,
      submissionId: params.id,
      fileName,
      totalSize: size,
    });
    return jsonNoStore({ uploadId: meta.id, chunkSize: getChunkSizeBytes(), offset: 0, size }, 201);
  } catch (err) {
    if (err instanceof TooManyUploadSessionsError) {
      return jsonNoStore(
        {
          error:
            `You already have ${MAX_ACTIVE_UPLOADS_PER_USER} uploads in progress. Finish or cancel one ` +
            '(unfinished uploads are cleared automatically after 24 hours), then try again.',
        },
        429
      );
    }
    if (err instanceof InsufficientStorageError) {
      return jsonNoStore(
        { error: "The server doesn't have enough free disk space for this upload right now." },
        507
      );
    }
    console.error('[patch upload] failed to start upload session:', err);
    return jsonNoStore({ error: 'Could not start the upload — please try again.' }, 500);
  }
}
