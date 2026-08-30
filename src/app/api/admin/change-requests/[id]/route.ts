// src/app/api/admin/change-requests/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { isMappingFieldKey } from '@/lib/mappingFields';
import { isSharedFieldKey, propagateSharedFields, propagateTags, reassignSubmissionFamily, FamilyReassignError, resolveReleaseFields } from '@/lib/hackFamily';
import { resolveMachineName, triggerHasheousPushForSubmission } from '@/lib/approval';
import { ensureTagsExist } from '@/lib/tags';

const reviewSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT']),
  reviewNote: z.string().max(1000).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const changeRequest = await prisma.changeRequest.findUnique({
    where: { id: params.id },
    include: { submission: true },
  });
  if (!changeRequest) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (changeRequest.status !== 'PENDING') {
    return NextResponse.json({ error: 'Already reviewed' }, { status: 409 });
  }

  const body = await req.json();
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 422 });
  }
  const { action, reviewNote } = parsed.data;

  if (action === 'REJECT') {
    await prisma.changeRequest.update({
      where: { id: params.id },
      data: { status: 'REJECTED', reviewedById: session.user.id, reviewedAt: new Date(), reviewNote },
    });
    await prisma.auditLog.create({
      data: {
        action: 'CHANGE_REQUEST_REJECTED',
        details: { reviewNote },
        userId: session.user.id,
        submissionId: changeRequest.submissionId,
      },
    });
    return NextResponse.json({ message: 'Rejected' });
  }

  // APPROVE: apply the proposed changes to the submission, syncing the live
  // DAT entry too if this submission is already approved and a rename-
  // relevant field is part of the change.
  const allChanges = changeRequest.changes as Record<string, string | number | null>;

  // Mapping fields (IGDB, GiantBomb, etc.) live on GameMapping, not
  // Submission — applying them via tx.submission.update() would fail since
  // those columns don't exist there. Split them out and upsert separately.
  const changes: Record<string, string | number | null> = {};
  const mappingChanges: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(allChanges)) {
    if (isMappingFieldKey(key)) mappingChanges[key] = value as string | null;
    else changes[key] = value;
  }
  // Same reasoning as create/PATCH: if either half of the release-date
  // pair was proposed, re-derive both from whichever was actually sent
  // rather than trusting them to already agree, and so that changing one
  // correctly clears the other when they represent different precisions
  // (e.g. a proposal that sets a real releaseDate should not leave a
  // stale, now-inconsistent releaseYear from before this request).
  if ('releaseDate' in changes || 'releaseYear' in changes) {
    const resolved = resolveReleaseFields({
      releaseDate: (changes.releaseDate as string | null | undefined) ?? null,
      releaseYear: (changes.releaseYear as number | null | undefined) ?? null,
    });
    changes.releaseDate = resolved.releaseDate;
    changes.releaseYear = resolved.releaseYear;
  }

  const hasSubmissionChanges = Object.keys(changes).length > 0;
  const hasMappingChanges = Object.keys(mappingChanges).length > 0;
  const renameFieldsChanged = ['hackName', 'version', 'platform'].some((f) => f in changes);

  // hackName/author/releaseYear/releaseDate/description changes fan out to
  // every other version of this hack on approval, honoring whatever the
  // requester chose when they proposed the change
  // (changeRequest.applyToAllVersions).
  const sharedChanges: { name?: string; author?: string | null; releaseYear?: number | null; releaseDate?: string | null; description?: string | null } = {};
  for (const [key, value] of Object.entries(changes)) {
    if (!isSharedFieldKey(key)) continue;
    if (key === 'hackName') sharedChanges.name = value as string;
    else (sharedChanges as Record<string, unknown>)[key] = value;
  }
  const hasSharedChanges = Object.keys(sharedChanges).length > 0;

  try {
    await prisma.$transaction(async (tx) => {
      const updated = hasSubmissionChanges
        ? await tx.submission.update({ where: { id: changeRequest.submissionId }, data: changes as any })
        : changeRequest.submission;

      if (hasSubmissionChanges && changeRequest.submission.status === 'APPROVED' && renameFieldsChanged) {
        const approvedEntry = await tx.approvedEntry.findUnique({ where: { submissionId: changeRequest.submissionId } });
        if (approvedEntry) {
          const desiredName = `${updated.hackName} (v${updated.version})`;
          const newMachineName = await resolveMachineName(tx, desiredName, updated.md5, changeRequest.submissionId);
          await tx.approvedEntry.update({
            where: { submissionId: changeRequest.submissionId },
            data: { machineName: newMachineName, description: newMachineName, platform: updated.platform },
          });
        }
      }

      if (hasMappingChanges) {
        if (changeRequest.submission.gameMappingId) {
          await tx.gameMapping.update({
            where: { id: changeRequest.submission.gameMappingId },
            data: mappingChanges,
          });
        } else {
          const mapping = await tx.gameMapping.create({ data: mappingChanges });
          await tx.submission.update({
            where: { id: changeRequest.submissionId },
            data: { gameMappingId: mapping.id },
          });
        }
      }

      // proposedTags is null when no tag change was proposed at all (vs. an
      // empty array, which explicitly proposes clearing every tag) — same
      // distinction the schema comment describes.
      let resolvedTagIds: string[] = [];
      const hasTagChanges = changeRequest.proposedTags !== null && changeRequest.proposedTags !== undefined;
      if (hasTagChanges) {
        const proposedSlugs = changeRequest.proposedTags as string[];
        await tx.submissionTag.deleteMany({ where: { submissionId: changeRequest.submissionId } });
        if (proposedSlugs.length) {
          const tagRows = await ensureTagsExist(tx, proposedSlugs);
          resolvedTagIds = tagRows.map((t) => t.id);
          await tx.submissionTag.createMany({
            data: tagRows.map((t) => ({ submissionId: changeRequest.submissionId, tagId: t.id })),
          });
        }
      }

      // proposedTranslationLanguages — same null-vs-present distinction as
      // proposedTags above, but deliberately never propagated to sibling
      // versions (per-version, like versionChangelog — see the schema
      // field's own comment in prisma/schema.prisma) — a direct write
      // only, no propagateX() call, and placed outside the
      // applyToAllVersions block below on purpose.
      const hasTranslationLanguageChanges =
        changeRequest.proposedTranslationLanguages !== null && changeRequest.proposedTranslationLanguages !== undefined;
      if (hasTranslationLanguageChanges) {
        await tx.submission.update({
          where: { id: changeRequest.submissionId },
          data: { translationLanguages: changeRequest.proposedTranslationLanguages as string[] },
        });
      }

      if (changeRequest.submission.hackFamilyId && changeRequest.applyToAllVersions) {
        if (hasSharedChanges) {
          await propagateSharedFields(tx, changeRequest.submission.hackFamilyId, changeRequest.submissionId, sharedChanges);
        }
        if (hasTagChanges) {
          await propagateTags(tx, changeRequest.submission.hackFamilyId, changeRequest.submissionId, resolvedTagIds);
        }
      }

      // Family reassignment is deliberately independent of
      // applyToAllVersions — that flag governs syncing shared FIELD values
      // to sibling versions, not membership itself. A proposed family
      // change applies (or doesn't) regardless of how that checkbox was
      // set when the request was submitted. reassignSubmissionFamily()
      // re-validates the target's platform against the submission's
      // CURRENT platform (which may itself have just changed a few lines
      // above, if this same request also proposed a platform change) —
      // not the platform that was in effect back when the request was
      // first proposed and eagerly checked.
      const hasFamilyChange = changeRequest.proposedFamily !== null && changeRequest.proposedFamily !== undefined;
      if (hasFamilyChange) {
        const proposed = changeRequest.proposedFamily as { id: string | null; name: string | null };
        await reassignSubmissionFamily(
          tx,
          { id: changeRequest.submissionId, hackFamilyId: updated.hackFamilyId, platform: updated.platform },
          proposed.id,
          session.user.id
        );
      }

      await tx.changeRequest.update({
        where: { id: params.id },
        data: { status: 'APPROVED', reviewedById: session.user.id, reviewedAt: new Date(), reviewNote },
      });

      await tx.auditLog.create({
        data: {
          action: 'CHANGE_REQUEST_APPROVED',
          details: {
            changes: allChanges,
            proposedTags: changeRequest.proposedTags,
            proposedTranslationLanguages: changeRequest.proposedTranslationLanguages,
            proposedFamily: changeRequest.proposedFamily,
            reviewNote,
            appliedToAllVersions: (hasSharedChanges || hasTagChanges) && !!changeRequest.submission.hackFamilyId && changeRequest.applyToAllVersions,
          },
          userId: session.user.id,
          submissionId: changeRequest.submissionId,
        },
      });
    }, { timeout: 15000 });
  } catch (err: any) {
    if (err instanceof FamilyReassignError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err?.code === 'P2002') {
      const target = Array.isArray(err?.meta?.target) ? err.meta.target.join(',') : String(err?.meta?.target ?? '');
      if (target.includes('nameKey') || target.includes('HackFamily')) {
        return NextResponse.json(
          { error: 'Applying this rename would collide with a different existing hack family on this platform.' },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: 'Applying this change would create a duplicate name in the DAT' },
        { status: 409 }
      );
    }
    console.error('Change request approval failed:', err);
    return NextResponse.json({ error: 'Approval failed — please try again' }, { status: 500 });
  }

  // Push the correction out immediately rather than waiting for the 30min
  // scheduler — which, notably, would NEVER pick this up on its own if the
  // mapping's push status was already 'confirmed' from an earlier push,
  // since that status permanently excludes it from the scheduler's scan and
  // nothing about approving a change request resets it. Only fires for an
  // already-APPROVED (live) submission — a change request can technically
  // be proposed against a not-yet-approved one too, and there's nothing to
  // tell Hasheous about until the community/admin has actually approved it
  // once. Fire-and-forget, same pattern as the two existing triggers in
  // approval.ts — never blocks this response, and triggerHasheousPushForSubmission
  // re-reads the submission fresh rather than trusting anything computed
  // above, so it always sends what's actually in the DB post-commit.
  if (hasMappingChanges && changeRequest.submission.status === 'APPROVED') {
    void triggerHasheousPushForSubmission(changeRequest.submissionId);
  }

  return NextResponse.json({ message: 'Approved and applied' });
}
