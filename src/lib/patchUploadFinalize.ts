// src/lib/patchUploadFinalize.ts
//
// The rules for "may this person attach this file to this submission, is the
// file an acceptable patch, and what gets recorded" — written ONCE and used
// by BOTH upload paths:
//   - the original single-request multipart POST (patch/route.ts), which has
//     the whole file in a Buffer, and
//   - the chunked upload's /complete step (patch/uploads/[uploadId]/complete),
//     which has a finished file on disk.
// Before this file existed those rules lived inline in patch/route.ts. They
// moved here verbatim (same order, same messages, same status codes) so a
// second upload path didn't mean a second copy of a security-relevant
// decision — the same "one function, imported by both" rule
// patchPermissions.ts documents for canManagePatchFile.
//
// What differs between the two paths is passed IN, not branched on here:
//   sample  head/tail/size of the file (fileSample.ts) — validation only ever
//           needs that, so neither path has to hand over the whole file;
//   sha1    computed by the caller from the real bytes (never trusted from
//           the client);
//   store   how the bytes reach their final path (write a Buffer vs move a
//           finished temp file) — called only after every check has passed.

import type { Prisma, Submission } from '@prisma/client';
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { checkPatchChunkRateLimit, checkPatchUploadRateLimit, rateLimitedResponse } from '@/lib/rateLimit';
import { arePatchUploadsDisabled, PATCH_UPLOADS_DISABLED_MESSAGE } from '@/lib/siteSettings';
import { canManagePatchFile, isPrivilegedPatchRole } from './patchPermissions';
import { type PatchTypeValue, patchTypeLabel } from './patchTypes';
import { validatePatchSample } from './patchValidation';
import {
  buildPatchDisplaySlug,
  buildPatchRelativePath,
  deletePatchFile,
  resolveRelativePath,
  resolveStoredPath,
} from './patchStorage';
import type { FileSample } from './fileSample';

/**
 * JSON response that must never be cached. Every chunked-upload response is
 * per-user, per-moment state (an offset, a session id); Cloudflare and the
 * browser are told explicitly rather than trusting default caching rules.
 */
export function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

// ── request gate shared by the four chunked-upload endpoints ───────────

export interface PatchUploadUser {
  id: string;
  role: string;
}

/**
 * Session + banned + (optionally) the admin kill switch + rate limit, in the
 * same order and with the same responses as the top of the legacy POST
 * handler. `rateLimit: 'start'` charges the existing 10-per-10-minutes
 * patchUpload bucket (one token per upload STARTED); 'chunk' charges a
 * separate, far more generous bucket, since a single large upload is dozens
 * of requests and would otherwise trip the start limit on its own.
 *
 * The kill switch is deliberately not checked for status/abort — cleaning up
 * or resuming-to-check an upload is not "uploading", same reasoning the
 * legacy route uses for leaving DELETE ungated.
 */
export async function requirePatchUploadUser(opts: {
  killSwitch: boolean;
  rateLimit: 'start' | 'chunk';
}): Promise<{ ok: true; user: PatchUploadUser } | { ok: false; response: NextResponse }> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return { ok: false, response: jsonNoStore({ error: 'Unauthorized' }, 401) };
  }
  if (session.user.isBanned) {
    return { ok: false, response: jsonNoStore({ error: 'Your account has been banned' }, 403) };
  }
  if (opts.killSwitch && (await arePatchUploadsDisabled())) {
    return {
      ok: false,
      response: jsonNoStore({ error: PATCH_UPLOADS_DISABLED_MESSAGE, uploadsDisabled: true }, 503),
    };
  }
  const limit =
    opts.rateLimit === 'start'
      ? await checkPatchUploadRateLimit(session.user.id)
      : await checkPatchChunkRateLimit(session.user.id);
  if (!limit.success) {
    return { ok: false, response: rateLimitedResponse(limit) };
  }
  return { ok: true, user: { id: session.user.id, role: session.user.role } };
}

// ── submission lookup + permission ─────────────────────────────────────

/** A Submission row plus just the base ROM name the patch's folder needs. */
export type SubmissionWithBaseRomName = Submission & { baseRom: { name: string } | null };

/**
 * Loads the submission and applies canManagePatchFile — the same checks, in
 * the same order, with the same messages as the legacy POST handler always
 * had inline. The chunked endpoints call this at start, on every chunk, and
 * again at complete: submission state can change mid-upload (approved,
 * deleted, a file attached by someone else), and a session must never
 * outlive the permission that created it.
 */
export async function loadAuthorizedSubmission(
  user: PatchUploadUser,
  submissionId: string,
  opts?: {
    /**
     * Bulk submit (bulkLimits.ts / submissionBatch.ts): set when the request
     * claimed a verified batch and was therefore given the bulk limiter. The
     * submission must really be one of that batch's rows — otherwise the batch
     * id would double as a way to get the higher upload allowance on unrelated
     * submissions. Checked AFTER "not found" and BEFORE the permission check,
     * the same precedence the route had when this lived inline.
     */
    requireBatchId?: string | null;
  }
): Promise<
  | { ok: true; submission: SubmissionWithBaseRomName; hadPriorFile: boolean }
  | { ok: false; response: NextResponse }
> {
  // The base ROM's name is loaded here (not looked up later) because it's one
  // of the folders the patch file is filed under — see buildPatchRelativePath.
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: { baseRom: { select: { name: true } } },
  });
  if (!submission || submission.deletedAt) {
    return { ok: false, response: jsonNoStore({ error: 'Submission not found' }, 404) };
  }
  if (opts?.requireBatchId && submission.batchId !== opts.requireBatchId) {
    return {
      ok: false,
      response: jsonNoStore(
        { error: 'That submission is not part of the batch this upload was sent under.' },
        400
      ),
    };
  }
  const hadPriorFile = !!submission.patchUploadedAt;
  const allowed = canManagePatchFile({
    viewerId: user.id,
    viewerRole: user.role,
    submittedById: submission.submittedById,
    status: submission.status,
    patchUploadedAt: submission.patchUploadedAt,
  });
  if (!allowed) {
    return {
      ok: false,
      response: jsonNoStore(
        {
          error: hadPriorFile
            ? 'A patch file is already attached to this entry — only an admin or verifier can replace or remove it.'
            : 'Forbidden — you can only upload a patch to your own submission while it is pending.',
        },
        403
      ),
    };
  }
  return { ok: true, submission, hadPriorFile };
}

// ── the actual finalize ────────────────────────────────────────────────

const FINALIZED_SELECT = {
  id: true,
  patchType: true,
  patchFilename: true,
  patchSha1: true,
  patchFileSize: true,
  patchUploadedAt: true,
  patchStoredSlug: true,
} as const satisfies Prisma.SubmissionSelect;

export type FinalizedSubmission = Prisma.SubmissionGetPayload<{ select: typeof FINALIZED_SELECT }>;

export interface FinalizeInput {
  submission: SubmissionWithBaseRomName;
  hadPriorFile: boolean;
  user: PatchUploadUser;
  fileName: string;
  sample: FileSample;
  /** Lowercase hex SHA-1 the CALLER computed from the real bytes. */
  sha1: string;
  /** Puts the bytes at their final path. Called only after every check has passed. */
  store: (dest: { relativePath: string }) => Promise<void>;
}

export type FinalizeResult =
  | { ok: true; submission: FinalizedSubmission }
  | {
      ok: false;
      status: number;
      body: Record<string, unknown>;
      /**
       * Chunked path only: whether the uploaded bytes are still worth keeping
       * for a retry of just the finish step. True for failures that a fix to
       * the submission's DECLARED metadata (or a transient storage error) can
       * resolve without re-sending gigabytes; false when the file itself is
       * the problem (not a patch, empty, too large) — those free the disk
       * immediately.
       */
      keepUpload: boolean;
    };

export async function finalizePatchUpload(input: FinalizeInput): Promise<FinalizeResult> {
  const { submission, hadPriorFile, user, fileName, sample, sha1: computedSha1 } = input;

  // The 'OTHER' escape hatch in validatePatchSample (accepting a file that
  // matches none of the six known patch signatures) is only ever offered to a
  // privileged uploader — the real, load-bearing control against "declare it
  // Other and upload a ROM," not the byte-level ROM/disc-image check
  // validatePatchSample also runs on that path (romDetection.ts), which is a
  // second, automatic layer on top of it, not a substitute. A non-privileged
  // submitter can still set patchType to 'OTHER' on their own submission (a
  // legitimate way to flag "my patch is in an uncommon format"), but their own
  // upload attempt is validated as if nothing were declared at all — an
  // undetectable file still gets the normal rejection, with a message pointing
  // at needing a moderator instead of the normal "try declaring Other"
  // suggestion, which would be actively misleading here since they already did
  // that and it didn't help.
  const isPrivileged = isPrivilegedPatchRole(user.role);
  const otherDeclaredButNotPrivileged = submission.patchType === 'OTHER' && !isPrivileged;
  const declaredTypeForValidation: PatchTypeValue | null = otherDeclaredButNotPrivileged
    ? null
    : (submission.patchType as PatchTypeValue | null);

  const validation = validatePatchSample(sample, declaredTypeForValidation);
  if (!validation.ok) {
    const message = otherDeclaredButNotPrivileged
      ? 'Only an admin or verifier can confirm and attach a patch declared as "Other" — please ask a moderator to review and upload this file.'
      : validation.reason;
    return { ok: false, status: 422, body: { error: message }, keepUpload: false };
  }
  const detectedType = validation.detectedType as PatchTypeValue;

  if (!hadPriorFile) {
    // First attachment: cross-check against whatever was already declared, if
    // anything (fieldLimits.ts's patchSha1 regex is case-insensitive and
    // doesn't normalize, so this compares lowercased). A privileged replace
    // (hadPriorFile === true) deliberately skips this — nothing to sensibly
    // cross-check a replacement against.
    if (submission.patchType && detectedType !== submission.patchType) {
      return {
        ok: false,
        status: 422,
        body: {
          error: `This file looks like a ${patchTypeLabel(detectedType)} patch, but ${patchTypeLabel(submission.patchType)} was selected for this submission. Double-check the patch type, or leave it blank and this upload will set it.`,
          // Structured alongside the message so a client can offer a direct
          // "use the detected type" fix instead of only rendering text (see
          // PatchFileUpload.tsx). Purely additive. This is NOT a claim that
          // the detected byte format is somehow more "correct" than what's
          // declared — it's just the format the actual bytes really are, per
          // detectPatchFormatFromSample(). Very often the honest explanation
          // is that the real-world file doesn't match its own extension (e.g.
          // a BPS patch someone named "*.ips" — a common mix-up in the wild,
          // not evidence of anything wrong with detection).
          patchTypeMismatch: { declaredType: submission.patchType, detectedType },
        },
        keepUpload: true,
      };
    }
    if (submission.patchSha1 && computedSha1 !== submission.patchSha1.toLowerCase()) {
      return {
        ok: false,
        status: 422,
        body: {
          error:
            "This file's SHA-1 doesn't match the hash already recorded for this submission's " +
            'patch. Re-drop the file into the patch details section first so the hash and file ' +
            'agree, then upload again — or clear that field and this upload will set it.',
        },
        keepUpload: true,
      };
    }
  }

  const effectiveType = detectedType;
  const effectiveSha1 = computedSha1;
  // A replace always uses the new file's own name; a first attachment prefers
  // whatever was already declared (so a deliberately-chosen display name from
  // the metadata step isn't clobbered by, say, a downloaded file literally
  // named "patch.bps").
  const effectiveFilename = hadPriorFile ? fileName : submission.patchFilename || fileName;

  // hackName/version are required fields on Submission — always present, no
  // fallback needed. The location (platform / base ROM / hack folders + file
  // name) is recomputed fresh on every (re-)upload — it reflects the CURRENT
  // names, not whatever they were on a previous upload — then PERSISTED
  // (patchStoredPath, never recomputed on read) so a later rename can't make
  // the file unfindable. See patchStorage.ts's header.
  const displaySlug = buildPatchDisplaySlug(submission.hackName, submission.version);
  const relativePath = buildPatchRelativePath({
    platform: submission.platform,
    baseRomName: submission.baseRom?.name,
    hackName: submission.hackName,
    version: submission.version,
    sha1: effectiveSha1,
    patchType: effectiveType,
  });

  try {
    await input.store({ relativePath });
  } catch (err) {
    console.error('[patch upload] failed to write patch file to storage:', err);
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to store the patch file — please try again.' },
      keepUpload: true,
    };
  }

  // Clean up the file this upload just superseded, if there was one AND it
  // lives somewhere other than where the new one just went. Compared by the
  // real resolved location, not by sha1/type/slug: a hackName/version/base-ROM
  // edit landing between two uploads of the byte-identical patch changes the
  // folder or file name without changing the hash, and would otherwise
  // silently orphan the old file — and a file still in the old flat layout
  // is superseded by the same bytes arriving in the folder layout. Best-effort
  // and non-blocking on purpose: the new file is already safely written and
  // the database is about to point at it, so a cleanup failure here is a
  // disk-space leak, not a correctness problem for anyone using the
  // submission going forward — logged loudly rather than left silent, but
  // never fails the request over it.
  if (hadPriorFile && submission.patchSha1 && submission.patchType) {
    try {
      const oldRef = {
        sha1: submission.patchSha1.toLowerCase(),
        patchType: submission.patchType as PatchTypeValue,
        storedPath: submission.patchStoredPath,
        storedSlug: submission.patchStoredSlug,
      };
      if (resolveStoredPath(oldRef) !== resolveRelativePath(relativePath)) {
        await deletePatchFile(oldRef);
      }
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
      patchFileSize: sample.size,
      patchUploadedAt: new Date(),
      patchUploadedById: user.id,
      patchStoredSlug: displaySlug,
      patchStoredPath: relativePath,
    },
    select: FINALIZED_SELECT,
  });

  return { ok: true, submission: updated };
}
