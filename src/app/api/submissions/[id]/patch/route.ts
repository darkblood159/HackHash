// src/app/api/submissions/[id]/patch/route.ts
//
// Uploads (POST), removes (DELETE), or downloads (GET) the actual patch
// FILE for a submission. POST here is the single-request path, used for
// files up to CHUNKED_UPLOAD_THRESHOLD_BYTES (patchUploadChunking.ts); larger
// files go through the chunked/resumable endpoints under ./uploads instead,
// because Cloudflare caps a single proxied request body (100MB Free/Pro).
// Both paths run the SAME validation/recording code (patchUploadFinalize.ts).
// Bulk submit (src/lib/bulkLimits.ts) also calls THIS single-request path, with
// `?batch=<id>`, for each row's patch — see the claim handling in POST below. Deliberately a separate call from submission
// create/edit — those are plain JSON endpoints, and multipart/form-data
// needs different parsing (request.formData()), same reason base-rom
// creation is its own prior call rather than part of the submit payload
// (see the schema comment on Submission.baseRomId).
//
// PERMISSION MODEL (src/lib/patchPermissions.ts, canManagePatchFile — the
// one place this rule is written, imported here AND by the submission
// detail page's UI, so the two can't drift apart): while no file is
// attached yet, the owner can upload while the submission is PENDING, or
// an admin/verifier can any time. Once a file IS attached, only
// ADMINISTRATOR or VERIFIER can touch it further — not even the original
// owner. Scoped per submission row: a different version (a separate
// Submission row) is a completely separate lock.
//
// METADATA: patchType/patchFilename/patchSha1 do NOT need to already be
// declared before uploading (they used to have to — section 2as). If they
// ARE already declared and this is the first file ever attached, the
// upload is cross-checked against them (catches "you dropped the wrong
// file"). If nothing was declared, or this is a privileged replace of an
// already-attached file, the uploaded file's own detected type + computed
// hash simply become the new truth — no declared value to cross-check a
// replace against, and forcing a replacement to match whatever it's
// superseding doesn't make sense.
import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { checkPatchUploadRateLimit, checkBulkPatchUploadRateLimit, checkSearchRateLimit, getClientIp, rateLimitedResponse } from '@/lib/rateLimit';
import { MAX_PATCH_FILE_SIZE_BYTES } from '@/lib/patchValidation';
import { sampleFromBuffer } from '@/lib/fileSample';
import { finalizePatchUpload, loadAuthorizedSubmission } from '@/lib/patchUploadFinalize';
import { writePatchFile, readPatchFile, deletePatchFile, storedPatchRef } from '@/lib/patchStorage';
import { canManagePatchFile } from '@/lib/patchPermissions';
import { arePatchUploadsDisabled, areBulkSubmitsDisabled, PATCH_UPLOADS_DISABLED_MESSAGE } from '@/lib/siteSettings';
import { loadOpenBatch, BatchError } from '@/lib/submissionBatch';

// Multipart overhead for a single-file form (boundary strings, the one
// field's headers) is at most a few hundred bytes in practice — 64KB of
// slack is generous, not tight, so this never falsely rejects a
// legitimately-sized file while still catching a Content-Length that's
// wildly over the limit before the body is ever read into memory.
const CONTENT_LENGTH_SLACK_BYTES = 64 * 1024;

// What formData.get('file') actually returns for a real file field — an
// undici File/Blob-like object with these three members, specifically.
interface UploadedFileLike {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

// Deliberately NOT `value instanceof File` — the global File constructor
// wasn't added to Node until v20 (the Docker image's own node:20-alpine
// base has it; an older Node running `npm run dev` locally, outside
// Docker, does not, and `instanceof File` throws ReferenceError: File is
// not defined before it ever gets to compare anything — a real bug
// report, not a hypothetical). Checking the actual shape instead needs no
// global to exist at all, works identically across Node versions, and
// still can't be satisfied by the plain string formData.get() returns for
// a text field, which is the only other thing it could actually be here.
function isUploadedFileLike(value: unknown): value is UploadedFileLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).name === 'string' &&
    typeof (value as Record<string, unknown>).size === 'number' &&
    typeof (value as Record<string, unknown>).arrayBuffer === 'function'
  );
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (session.user.isBanned) {
    return NextResponse.json({ error: 'Your account has been banned' }, { status: 403 });
  }

  // Admin kill switch (src/lib/siteSettings.ts) — checked before the rate
  // limit is even consumed and before the submission is looked up, since
  // there's no point charging either against an attempt that's guaranteed
  // to be rejected. Deliberately does NOT gate DELETE (removing a file
  // isn't "uploading" one) or GET below (downloading an already-stored
  // patch, and the in-browser apply flow that depends on it, is the
  // separate "patching" feature this switch is specifically NOT meant to
  // touch — see siteSettings.ts's own comment on the scope of this).
  if (await arePatchUploadsDisabled()) {
    return NextResponse.json({ error: PATCH_UPLOADS_DISABLED_MESSAGE, uploadsDisabled: true }, { status: 503 });
  }

  // Bulk submit uploads one patch per created version in quick succession,
  // which the ordinary 10-per-10-minutes limit would cut off partway through
  // a batch. A request may say it belongs to a batch (`?batch=<id>`); it only
  // gets the bulk limiter if that batch is the caller's own, unwithdrawn and
  // still open (loadOpenBatch), AND — checked once the submission is loaded,
  // below — the submission really is one of that batch's rows. A stale,
  // foreign, or switched-off claim silently falls back to the ordinary
  // limiter rather than failing, so a wrong claim never blocks an upload the
  // normal path would allow. DELETE below is unchanged on purpose.
  const claimedBatch = req.nextUrl.searchParams.get('batch');
  let bulkBatchId: string | null = null;
  if (claimedBatch && claimedBatch.length <= 64 && !(await areBulkSubmitsDisabled())) {
    try {
      await loadOpenBatch(claimedBatch, session.user.id);
      bulkBatchId = claimedBatch;
    } catch (err) {
      if (!(err instanceof BatchError)) throw err;
    }
  }

  const rateLimit = bulkBatchId
    ? await checkBulkPatchUploadRateLimit(session.user.id)
    : await checkPatchUploadRateLimit(session.user.id);
  if (!rateLimit.success) {
    return rateLimitedResponse(rateLimit);
  }

  // Cheap rejection before the body is read at all. Content-Length can be
  // absent (e.g. chunked transfer-encoding with no declared length), so
  // this is a fast-path, not the only guard — file.size is re-checked
  // below once the form has actually been parsed.
  const contentLength = req.headers.get('content-length');
  if (contentLength) {
    const declaredSize = Number.parseInt(contentLength, 10);
    if (Number.isFinite(declaredSize) && declaredSize > MAX_PATCH_FILE_SIZE_BYTES + CONTENT_LENGTH_SLACK_BYTES) {
      const limitMb = (MAX_PATCH_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0);
      return NextResponse.json(
        { error: `File is larger than the ${limitMb}MB limit for patch uploads.` },
        { status: 413 }
      );
    }
  }

  // Submission lookup + canManagePatchFile (patchUploadFinalize.ts) — the same
  // checks and messages this handler always had inline, now shared with the
  // chunked upload endpoints so the permission rule has one implementation.
  // `requireBatchId`: the bulk limiter above was chosen on the strength of the
  // claimed batch alone, so the loader also verifies the submission really is
  // one of that batch's rows (400 otherwise) — after "not found", before the
  // permission check, exactly where this check sat before the refactor.
  const auth = await loadAuthorizedSubmission(
    { id: session.user.id, role: session.user.role },
    params.id,
    { requireBatchId: bulkBatchId }
  );
  if (!auth.ok) return auth.response;
  const { submission, hadPriorFile } = auth;

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json(
      { error: 'Expected multipart/form-data with a "file" field.' },
      { status: 400 }
    );
  }

  const file = formData.get('file');
  if (!isUploadedFileLike(file)) {
    return NextResponse.json({ error: 'Missing "file" field.' }, { status: 400 });
  }
  if (file.size > MAX_PATCH_FILE_SIZE_BYTES) {
    const limitMb = (MAX_PATCH_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0);
    return NextResponse.json(
      { error: `File is larger than the ${limitMb}MB limit for patch uploads.` },
      { status: 413 }
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  // Always computed fresh from the actual bytes received — never trusted
  // just because a value is already sitting in the database.
  const computedSha1 = crypto.createHash('sha1').update(bytes).digest('hex'); // Node's digest('hex') is always lowercase

  // Everything from here — validation (incl. the privileged-only 'OTHER'
  // escape hatch), the declared-type / declared-hash cross-checks, storing
  // the file, cleaning up a superseded one, and recording it on the
  // submission — lives in finalizePatchUpload (patchUploadFinalize.ts), the
  // single implementation shared with the chunked upload's /complete step.
  // It moved there verbatim; this handler only supplies WHERE THE BYTES ARE
  // (an in-memory Buffer, hence sampleFromBuffer + writePatchFile).
  const result = await finalizePatchUpload({
    submission,
    hadPriorFile,
    user: { id: session.user.id, role: session.user.role },
    fileName: file.name,
    sample: sampleFromBuffer(bytes),
    sha1: computedSha1,
    store: (dest) => writePatchFile(dest.relativePath, bytes),
  });
  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }
  return NextResponse.json({ success: true, submission: result.submission }, { status: 200 });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (session.user.isBanned) {
    return NextResponse.json({ error: 'Your account has been banned' }, { status: 403 });
  }

  const rateLimit = await checkPatchUploadRateLimit(session.user.id);
  if (!rateLimit.success) {
    return rateLimitedResponse(rateLimit);
  }

  const submission = await prisma.submission.findUnique({ where: { id: params.id } });
  if (!submission || submission.deletedAt) {
    return NextResponse.json({ error: 'Submission not found' }, { status: 404 });
  }

  // canManagePatchFile only grants non-privileged access while
  // patchUploadedAt is null — with nothing to remove in that state,
  // reaching this route with allowed === true is only ever actually
  // possible for an admin or verifier. Not special-cased; just how the
  // one shared rule already behaves here.
  const allowed = canManagePatchFile({
    viewerId: session.user.id,
    viewerRole: session.user.role,
    submittedById: submission.submittedById,
    status: submission.status,
    patchUploadedAt: submission.patchUploadedAt,
  });
  if (!allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (!submission.patchUploadedAt || !submission.patchSha1 || !submission.patchType) {
    return NextResponse.json({ error: 'No patch file is attached to this submission.' }, { status: 400 });
  }

  try {
    await deletePatchFile(storedPatchRef(submission));
  } catch (err) {
    console.error('[patch remove] failed to delete the stored file:', err);
    return NextResponse.json({ error: 'Failed to remove the stored file — please try again.' }, { status: 500 });
  }

  // Deliberately leaves patchType/patchFilename/patchSha1 as they were —
  // those describe the DECLARED/expected patch identity, meaningful on
  // their own even with no file attached (same as before section 2as ever
  // existed). Only the upload-tracking fields (file existence, size,
  // who/when, on-disk location) get cleared. Clearing patchUploadedAt also
  // reopens the owner-while-PENDING path for a fresh upload, if the
  // submission is still PENDING.
  const updated = await prisma.submission.update({
    where: { id: submission.id },
    data: {
      patchFileSize: null,
      patchUploadedAt: null,
      patchUploadedById: null,
      patchStoredSlug: null,
      patchStoredPath: null,
    },
    select: { id: true, patchUploadedAt: true },
  });

  return NextResponse.json({ success: true, submission: updated }, { status: 200 });
}

// Serves the actual patch bytes — approved entries are downloadable by
// anyone (this is the whole point of hosting the patch at all: legal
// distribution of a hack without ever touching the base ROM); read-only
// access to a not-yet-approved submission's own patch is limited to its
// owner or an admin/verifier, same reviewers who could act on it via
// POST/DELETE above.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const rateLimit = await checkSearchRateLimit(getClientIp(req));
  if (!rateLimit.success) {
    return rateLimitedResponse(rateLimit);
  }

  const submission = await prisma.submission.findUnique({ where: { id: params.id } });
  if (!submission || submission.deletedAt) {
    return NextResponse.json({ error: 'Submission not found' }, { status: 404 });
  }
  if (!submission.patchUploadedAt || !submission.patchSha1 || !submission.patchType) {
    return NextResponse.json({ error: 'No patch file is attached to this submission.' }, { status: 404 });
  }

  if (submission.status !== 'APPROVED') {
    const session = await getServerSession(authOptions);
    const isPrivileged = session?.user?.role === 'ADMINISTRATOR' || session?.user?.role === 'VERIFIER';
    const isOwner = session?.user?.id === submission.submittedById;
    if (!isPrivileged && !isOwner) {
      return NextResponse.json({ error: 'This submission has not been approved yet.' }, { status: 403 });
    }
  }

  let bytes: Buffer;
  try {
    bytes = await readPatchFile(storedPatchRef(submission));
  } catch (err) {
    console.error('[patch download] failed to read the stored file:', err);
    return NextResponse.json({ error: 'The patch file could not be read from storage.' }, { status: 500 });
  }

  // Filename quoting is deliberately minimal (strip embedded double
  // quotes only) — patchFilename already goes through fieldLimits.ts's
  // length/shape validation elsewhere, so this isn't the only line of
  // defense against something pathological ending up in a Content-
  // Disposition header, just a cheap extra safeguard here specifically.
  const downloadName = (submission.patchFilename || `patch.${submission.patchType.toLowerCase()}`).replace(/"/g, '');

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${downloadName}"`,
      'Content-Length': String(bytes.length),
      // Patches are re-downloadable any time and rarely change once
      // approved (replacing one goes through the admin/verifier-only
      // lock, section 2av) — an hour of caching cuts repeat requests
      // (e.g. a browser-patch retry) without risking staleness beyond
      // what re-uploading already implies people expect to wait out.
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
