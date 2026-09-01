// src/app/api/submissions/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { PLATFORMS } from '@/types';
import { MAPPING_FIELD_KEYS, stripMappingValues } from '@/lib/mappingFields';
import { ALL_TAG_SLUGS, ensureTagsExist } from '@/lib/tags';
import { LANGUAGE_CODES } from '@/lib/languages';
import { propagateSharedFields, propagateTags, resolveReleaseFields } from '@/lib/hackFamily';
import { validateBaseRomAssignment, BaseRomAssignError } from '@/lib/baseRom';
import { resolveMachineName, triggerHasheousPushForSubmission } from '@/lib/approval';

// ─── GET /api/submissions/:id ─────────────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  const isAdmin = session?.user?.role === 'ADMINISTRATOR';

  const submission = await prisma.submission.findUnique({
    where: { id: params.id },
    include: {
      submittedBy: {
        select: { id: true, name: true, image: true, username: true, trustScore: true, role: true },
      },
      verifications: {
        include: {
          user: { select: { id: true, name: true, image: true, username: true, trustScore: true, role: true } },
        },
        orderBy: { createdAt: 'desc' },
      },
      screenshots: true,
      tags: { include: { tag: true } },
      comments: {
        where: { isDeleted: false },
        include: {
          user: { select: { id: true, name: true, image: true, username: true, role: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
      auditLogs: {
        include: {
          user: { select: { id: true, name: true, username: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      },
      duplicateReports: {
        include: {
          user: { select: { id: true, name: true, username: true } },
          original: { select: { id: true, hackName: true } },
        },
      },
      approvedEntry: true,
      gameMapping: true,
      _count: { select: { verifications: true, comments: true } },
    },
  });

  if (!submission) {
    return NextResponse.json({ error: 'Submission not found' }, { status: 404 });
  }

  // Soft-deleted submissions are 404 to anyone but an administrator — same
  // response as "doesn't exist" so a deleted entry's URL doesn't leak that
  // it was specifically removed.
  if (submission.deletedAt && !isAdmin) {
    return NextResponse.json({ error: 'Submission not found' }, { status: 404 });
  }

  // Convert BigInt to string for JSON serialization
  return NextResponse.json({
    ...submission,
    fileSize: submission.fileSize.toString(),
  });
}

// ─── PATCH /api/submissions/:id ───────────────────────────────────────────────

// Length/format limits mirroring what POST /api/submissions (create) already
// enforces — this route never had ANY of these checks before, discovered
// while diagnosing a real user-facing "Validation failed" report (a
// versionChangelog over the create route's 3000-char cap): the create flow
// caught it, but an admin editing the same field through AdminEditPanel had
// nothing stopping an arbitrarily long value from saving silently, since
// these are all @db.Text columns with no length cap at the database level
// either. .partial() so any subset of fields can be present — updateData
// only ever contains whichever keys the request actually touched, and Zod's
// default (non-.strict()) object parsing silently ignores keys this schema
// doesn't know about (baseRomId, releaseYear/releaseDate, etc. — those have
// their own separate checks elsewhere in this file), so this only ever
// validates the fields it's actually meant to cover.
//
// Deliberately relaxed from create's own rules in one way: author has no
// .min(1) here even though create requires a non-empty value when the field
// is present at all. Create never needs to represent "clear this field" (a
// fresh submission has nothing to clear FROM); an edit does — an admin
// removing a wrongly-attributed author needs to be able to save an empty
// string. hackName/version keep create's .min(1) unchanged since those are
// never meant to be clearable to empty on a submission that already exists.
const patchFieldLimits = z.object({
  hackName: z.string().min(1).max(200),
  version: z.string().min(1).max(50),
  description: z.string().max(5000),
  versionChangelog: z.string().max(3000),
  author: z.string().max(200),
  platform: z.enum(PLATFORMS),
  sourceUrl: z.string().url(),
  notes: z.string().max(5000),
  releasePageUrl: z.string().url().or(z.literal('')),
  githubUrl: z.string().url().or(z.literal('')),
  patchType: z.enum(['IPS', 'BPS', 'UPS', 'XDELTA', 'PPF', 'APS']),
  patchFilename: z.string().max(500),
  patchSha1: z.string().regex(/^[0-9a-f]{40}$/i),
}).partial();

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const submission = await prisma.submission.findUnique({ where: { id: params.id } });
  if (!submission) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const isAdmin = session.user.role === 'ADMINISTRATOR';
  const isOwner = submission.submittedById === session.user.id;

  if (!isAdmin && !isOwner) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Owners can only edit PENDING submissions
  if (isOwner && !isAdmin && submission.status !== 'PENDING') {
    return NextResponse.json({ error: 'Cannot edit a submission that is no longer pending' }, { status: 409 });
  }

  const body = await req.json();
  const allowedFields = ['hackName', 'version', 'description', 'versionChangelog', 'author', 'releaseYear', 'releaseDate', 'platform',
    'sourceUrl', 'notes', 'releasePageUrl', 'githubUrl', 'patchType', 'patchFilename', 'patchSha1', 'baseRomId'];

  const updateData: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (field in body) {
      updateData[field] = body[field];
    }
  }

  // If either half of the release-date pair is being touched, re-derive
  // both from whichever was actually sent rather than trusting the two to
  // already agree — same reasoning as create (resolveReleaseFields() in
  // src/lib/hackFamily.ts). The UI always sends both keys together when
  // this section is edited (one will be null, reflecting the "full date"
  // vs "year only" toggle), so this also has the effect of correctly
  // clearing whichever one the edit is switching away from.
  if ('releaseDate' in updateData || 'releaseYear' in updateData) {
    const resolved = resolveReleaseFields({
      releaseDate: (updateData.releaseDate as string | null | undefined) ?? null,
      releaseYear: (updateData.releaseYear as number | null | undefined) ?? null,
    });
    updateData.releaseDate = resolved.releaseDate;
    updateData.releaseYear = resolved.releaseYear;
  }

  // Mapping fields (IGDB, GiantBomb, RetroAchievements, etc.) live on a
  // separate GameMapping row, not on Submission — pull them out and
  // normalize/strip them the same way manual submit-time entry and the
  // Hasheous pull job do, so a pasted URL never lands in the DB unstripped.
  const rawMappingChanges: Record<string, string | null> = {};
  for (const key of MAPPING_FIELD_KEYS) {
    if (key in body) rawMappingChanges[key] = body[key];
  }
  const hasMappingChanges = Object.keys(rawMappingChanges).length > 0;
  const mappingChanges = stripMappingValues(rawMappingChanges);

  // Tags — a full replace-set semantics (matches how tag selection works at
  // submission time: the submitter picks the complete set they want, not
  // individual add/remove diffs). Silently drops any slug that isn't a real
  // tag rather than erroring, since this isn't user-facing input validation.
  const hasTagChanges = Array.isArray(body.tags);
  const tagSlugs: string[] = hasTagChanges
    ? (body.tags as unknown[]).filter((t): t is string => typeof t === 'string' && ALL_TAG_SLUGS.includes(t as any))
    : [];

  // translationLanguages — same full-replace-set semantics as tags, but
  // deliberately NOT part of sharedChanges/propagateSharedFields below:
  // this is per-version, like versionChangelog, so it goes straight onto
  // updateData and is never fanned out to sibling versions.
  if (Array.isArray(body.translationLanguages)) {
    updateData.translationLanguages = (body.translationLanguages as unknown[]).filter(
      (c): c is string => typeof c === 'string' && LANGUAGE_CODES.includes(c)
    );
  }

  const fieldCheck = patchFieldLimits.safeParse(updateData);
  if (!fieldCheck.success) {
    // Logged server-side too, same reasoning as the matching addition on
    // POST /api/submissions — shows up directly in the terminal instead of
    // only being visible in the response body via devtools.
    console.error('PATCH /api/submissions/[id] validation failed:', JSON.stringify(fieldCheck.error.flatten()));
    return NextResponse.json({ error: 'Validation failed', details: fieldCheck.error.flatten() }, { status: 422 });
  }

  // If this submission belongs to a HackFamily (another version of the same
  // hack), whether the shared-field changes below (hackName/author/
  // releaseYear/releaseDate/description/tags) should fan out to every other version.
  // Defaults true. A submission with no hackFamilyId yet (pre-backfill) has
  // nothing to fan out to regardless.
  const applyToAllVersions = body.applyToAllVersions !== false;
  const sharedChanges: { name?: string; author?: string | null; releaseYear?: number | null; releaseDate?: string | null; description?: string | null } = {};
  if ('hackName' in updateData) sharedChanges.name = updateData.hackName as string;
  if ('author' in updateData) sharedChanges.author = updateData.author as string | null;
  if ('releaseYear' in updateData) sharedChanges.releaseYear = updateData.releaseYear as number | null;
  if ('releaseDate' in updateData) sharedChanges.releaseDate = updateData.releaseDate as string | null;
  if ('description' in updateData) sharedChanges.description = updateData.description as string | null;
  const hasSharedChanges = Object.keys(sharedChanges).length > 0;

  // If this submission is already approved and the rename-relevant fields are
  // changing, keep the live DAT entry (ApprovedEntry) in sync in the same
  // transaction — otherwise a "rename" would silently not affect the actual
  // exported DAT, which is the whole point of renaming an approved entry.
  const renameFieldsChanged = ['hackName', 'version', 'platform'].some((f) => f in updateData);

  // If baseRomId is being changed, validate the target before hitting the
  // transaction — same reasoning as the existence-only version of this
  // check used to have (a raw FK violation is a confusing 500, this is a
  // clean 4xx), now extended to also catch a platform mismatch and a
  // REJECTED target, the same two things reassignSubmissionFamily already
  // enforces for hackFamilyId — baseRomId never had either check before
  // this. Captures the target's name for a richer audit-log entry below,
  // since this lookup already has it in hand.
  let baseRomChangeDetail: { from: string | null; to: string; toName: string } | null = null;
  if ('baseRomId' in updateData && updateData.baseRomId) {
    try {
      const target = await validateBaseRomAssignment(prisma, updateData.baseRomId as string, (updateData.platform as string | undefined) ?? submission.platform);
      baseRomChangeDetail = { from: submission.baseRomId, to: updateData.baseRomId as string, toName: target.name };
    } catch (err) {
      if (err instanceof BaseRomAssignError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  }

  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      const result = await tx.submission.update({
        where: { id: params.id },
        data: updateData,
      });

      if (submission.status === 'APPROVED' && renameFieldsChanged) {
        const approvedEntry = await tx.approvedEntry.findUnique({ where: { submissionId: params.id } });
        if (approvedEntry) {
          const desiredName = `${result.hackName} (v${result.version})`;
          const newMachineName = await resolveMachineName(tx, desiredName, result.md5, params.id);
          await tx.approvedEntry.update({
            where: { submissionId: params.id },
            data: {
              machineName: newMachineName,
              description: newMachineName,
              platform: result.platform,
            },
          });
        }
      }

      if (hasMappingChanges) {
        if (submission.gameMappingId) {
          await tx.gameMapping.update({
            where: { id: submission.gameMappingId },
            data: mappingChanges,
          });
        } else {
          const mapping = await tx.gameMapping.create({ data: mappingChanges });
          await tx.submission.update({
            where: { id: params.id },
            data: { gameMappingId: mapping.id },
          });
        }
      }

      let resolvedTagIds: string[] = [];
      if (hasTagChanges) {
        await tx.submissionTag.deleteMany({ where: { submissionId: params.id } });
        if (tagSlugs.length) {
          const tagRows = await ensureTagsExist(tx, tagSlugs);
          resolvedTagIds = tagRows.map((t) => t.id);
          await tx.submissionTag.createMany({
            data: tagRows.map((t) => ({ submissionId: params.id, tagId: t.id })),
          });
        }
      }

      // Fan hackName/author/releaseYear/releaseDate/description/tags out to every other
      // version of this hack, unless the submitter asked to keep this one
      // different. Nothing to do for a submission that isn't grouped yet
      // (hackFamilyId null — runs after the one-time backfill).
      if (submission.hackFamilyId && applyToAllVersions) {
        if (hasSharedChanges) {
          await propagateSharedFields(tx, submission.hackFamilyId, params.id, sharedChanges);
        }
        if (hasTagChanges) {
          await propagateTags(tx, submission.hackFamilyId, params.id, resolvedTagIds);
        }
      }

      return result;
    });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      const target = Array.isArray(err?.meta?.target) ? err.meta.target.join(',') : String(err?.meta?.target ?? '');
      if (target.includes('nameKey') || target.includes('HackFamily')) {
        return NextResponse.json(
          { error: 'Renaming to this name would collide with a different existing hack family on this platform. Pick a different name, or rename that other family first.' },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: 'An entry with that resulting name already exists in the DAT. Use a more specific name or version.' },
        { status: 409 }
      );
    }
    throw err;
  }

  await prisma.auditLog.create({
    data: {
      action: submission.status === 'APPROVED' && renameFieldsChanged ? 'SUBMISSION_RENAMED' : 'SUBMISSION_EDITED',
      details: {
        fields: [...Object.keys(updateData), ...Object.keys(mappingChanges), ...(hasTagChanges ? ['tags'] : [])],
        by: session.user.id,
        appliedToAllVersions: !!submission.hackFamilyId && applyToAllVersions && (hasSharedChanges || hasTagChanges),
        ...(baseRomChangeDetail ? { baseRomChange: baseRomChangeDetail } : {}),
      },
      userId: session.user.id,
      submissionId: params.id,
    },
  });

  // Same reasoning as the matching addition in the change-request approval
  // route: push right away rather than waiting on the 30min scheduler, which
  // wouldn't reliably pick this up anyway (permanently skips anything already
  // 'confirmed', and this edit doesn't touch that field). Deliberately admin-
  // only — an owner editing their own still-PENDING submission (the other
  // case this same route handles, per the isOwner check above) has nothing
  // approved yet, so there's nothing to tell a public community database
  // about. isAdmin + APPROVED together is the actual "corrected a live
  // link" case this was asked for.
  if (hasMappingChanges && isAdmin && submission.status === 'APPROVED') {
    void triggerHasheousPushForSubmission(params.id);
  }

  return NextResponse.json({ ...updated, fileSize: updated.fileSize.toString() });
}

// ─── DELETE /api/submissions/:id ──────────────────────────────────────────────

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const submission = await prisma.submission.findUnique({ where: { id: params.id } });
  if (!submission) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (submission.deletedAt) {
    return NextResponse.json({ error: 'Already deleted' }, { status: 409 });
  }

  // True soft-delete: deletedAt/deletedById, separate from `status`. This
  // hides the submission from all public views (list, search, detail, DAT
  // export) while leaving its review status untouched, and is reversible
  // via POST /api/admin/submissions/:id/restore.
  await prisma.submission.update({
    where: { id: params.id },
    data: { deletedAt: new Date(), deletedById: session.user.id },
  });

  await prisma.auditLog.create({
    data: {
      action: 'SUBMISSION_SOFT_DELETED',
      details: { reason: 'Admin action' },
      userId: session.user.id,
      submissionId: params.id,
    },
  });

  return NextResponse.json({ message: 'Submission deleted — restorable from the admin deleted-items view' });
}
