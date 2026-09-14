// src/app/api/submissions/[id]/patch/route.ts
//
// Uploads (POST), removes (DELETE), or downloads (GET) the actual patch
// FILE for a submission. Deliberately a separate call from submission
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
import { checkPatchUploadRateLimit, checkSearchRateLimit, getClientIp, rateLimitedResponse } from '@/lib/rateLimit';
import { validatePatchUpload, MAX_PATCH_FILE_SIZE_BYTES } from '@/lib/patchValidation';
import { writePatchFile, readPatchFile, deletePatchFile, buildPatchDisplaySlug } from '@/lib/patchStorage';
import { canManagePatchFile } from '@/lib/patchPermissions';
import type { PatchTypeValue } from '@/lib/patchTypes';

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

  const rateLimit = await checkPatchUploadRateLimit(session.user.id);
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

  const submission = await prisma.submission.findUnique({ where: { id: params.id } });
  if (!submission || submission.deletedAt) {
    return NextResponse.json({ error: 'Submission not found' }, { status: 404 });
  }

  const hadPriorFile = !!submission.patchUploadedAt;

  const allowed = canManagePatchFile({
    viewerId: session.user.id,
    viewerRole: session.user.role,
    submittedById: submission.submittedById,
    status: submission.status,
    patchUploadedAt: submission.patchUploadedAt,
  });
  if (!allowed) {
    return NextResponse.json(
      {
        error: hadPriorFile
          ? 'A patch file is already attached to this entry — only an admin or verifier can replace or remove it.'
          : 'Forbidden — you can only upload a patch to your own submission while it is pending.',
      },
      { status: 403 }
    );
  }

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

  const validation = validatePatchUpload(bytes);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.reason }, { status: 422 });
  }
  const detectedType = validation.detectedType as PatchTypeValue;

  if (!hadPriorFile) {
    // First attachment: cross-check against whatever was already
    // declared, if anything (fieldLimits.ts's patchSha1 regex is
    // case-insensitive and doesn't normalize, so this compares
    // lowercased). A privileged replace (below, hadPriorFile === true)
    // deliberately skips this — nothing to sensibly cross-check a
    // replacement against.
    if (submission.patchType && detectedType !== submission.patchType) {
      return NextResponse.json(
        {
          error: `This file looks like a ${detectedType} patch, but ${submission.patchType} was selected for this submission. Double-check the patch type, or leave it blank and this upload will set it.`,
          // Structured alongside the message above so a client can offer a
          // direct "use the detected type" fix instead of only rendering
          // text (see PatchFileUpload.tsx). Purely additive — anything
          // that only reads `error` behaves exactly as it did before.
          // This is NOT a claim that the detected byte format is somehow
          // more "correct" than what's declared — it's just the format
          // the actual bytes really are, per detectPatchFormat(). Very
          // often the honest explanation for this mismatch is that the
          // real-world file simply doesn't match its own extension (e.g.
          // a BPS patch someone named/renamed "*.ips" — a common mix-up
          // in the wild, not evidence of anything wrong with detection).
          patchTypeMismatch: { declaredType: submission.patchType, detectedType },
        },
        { status: 422 }
      );
    }
    if (submission.patchSha1 && computedSha1 !== submission.patchSha1.toLowerCase()) {
      return NextResponse.json(
        {
          error:
            "This file's SHA-1 doesn't match the hash already recorded for this submission's " +
            'patch. Re-drop the file into the patch details section first so the hash and file ' +
            'agree, then upload again — or clear that field and this upload will set it.',
        },
        { status: 422 }
      );
    }
  }

  const effectiveType = detectedType;
  const effectiveSha1 = computedSha1;
  // A replace always uses the new file's own name; a first attachment
  // prefers whatever was already declared (so a deliberately-chosen
  // display name from the metadata step isn't clobbered by, say, a
  // downloaded file literally named "patch.bps").
  const effectiveFilename = hadPriorFile ? file.name : submission.patchFilename || file.name;

  // hackName/version are required fields on Submission — always present,
  // no fallback needed. Recomputed fresh on every (re-)upload (reflects
  // the CURRENT hackName/version, not whatever they were on a previous
  // upload) then PERSISTED (not recomputed on read) — see section 2au.
  const displaySlug = buildPatchDisplaySlug(submission.hackName, submission.version);

  try {
    await writePatchFile(effectiveSha1, effectiveType, displaySlug, bytes);
  } catch (err) {
    console.error('[patch upload] failed to write patch file to storage:', err);
    return NextResponse.json(
      { error: 'Failed to store the patch file — please try again.' },
      { status: 500 }
    );
  }

  // Clean up the file this upload just superseded, if there was one AND
  // its identity actually differs from the new one. "Differs" has to
  // check all three of sha1/type/slug, not just sha1: the slug alone can
  // change between uploads (a hackName/version edit landing between two
  // uploads of the byte-identical patch) and would otherwise silently
  // orphan the old-slug file on disk even though the hash never changed.
  // Best-effort and non-blocking on purpose: the new file is already
  // safely written and the database is about to point at it, so a
  // cleanup failure here is a disk-space leak, not a correctness problem
  // for anyone using the submission going forward — logged loudly rather
  // than left silent, but never fails the request over it.
  if (
    hadPriorFile &&
    submission.patchSha1 &&
    submission.patchType &&
    (submission.patchSha1.toLowerCase() !== effectiveSha1 ||
      submission.patchType !== effectiveType ||
      submission.patchStoredSlug !== displaySlug)
  ) {
    try {
      await deletePatchFile(
        submission.patchSha1.toLowerCase(),
        submission.patchType,
        submission.patchStoredSlug || 'patch'
      );
    } catch (err) {
      console.error(
        '[patch upload] failed to clean up the superseded patch file (new upload still succeeded):',
        err
      );
    }
  }

  const updated = await prisma.submission.update({
    where: { id: submission.id },
    data: {
      patchType: effectiveType,
      patchFilename: effectiveFilename,
      patchSha1: effectiveSha1,
      patchFileSize: bytes.length,
      patchUploadedAt: new Date(),
      patchUploadedById: session.user.id,
      patchStoredSlug: displaySlug,
    },
    select: {
      id: true,
      patchType: true,
      patchFilename: true,
      patchSha1: true,
      patchFileSize: true,
      patchUploadedAt: true,
      patchStoredSlug: true,
    },
  });

  return NextResponse.json({ success: true, submission: updated }, { status: 200 });
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
    await deletePatchFile(
      submission.patchSha1.toLowerCase(),
      submission.patchType,
      submission.patchStoredSlug || 'patch'
    );
  } catch (err) {
    console.error('[patch remove] failed to delete the stored file:', err);
    return NextResponse.json({ error: 'Failed to remove the stored file — please try again.' }, { status: 500 });
  }

  // Deliberately leaves patchType/patchFilename/patchSha1 as they were —
  // those describe the DECLARED/expected patch identity, meaningful on
  // their own even with no file attached (same as before section 2as ever
  // existed). Only the upload-tracking fields (file existence, size,
  // who/when, on-disk slug) get cleared. Clearing patchUploadedAt also
  // reopens the owner-while-PENDING path for a fresh upload, if the
  // submission is still PENDING.
  const updated = await prisma.submission.update({
    where: { id: submission.id },
    data: {
      patchFileSize: null,
      patchUploadedAt: null,
      patchUploadedById: null,
      patchStoredSlug: null,
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
    bytes = await readPatchFile(
      submission.patchSha1.toLowerCase(),
      submission.patchType,
      submission.patchStoredSlug || 'patch'
    );
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
