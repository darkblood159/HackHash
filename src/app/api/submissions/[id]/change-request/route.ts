// src/app/api/submissions/[id]/change-request/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { MAPPING_FIELD_KEYS, stripMappingValues, isMappingFieldKey } from '@/lib/mappingFields';
import { SHARED_FIELD_KEYS } from '@/lib/hackFamily';
import { ALL_TAG_SLUGS } from '@/lib/tags';
import { LANGUAGE_CODES } from '@/lib/languages';

const EDITABLE_FIELDS = [
  ...SHARED_FIELD_KEYS, 'version', 'versionChangelog', 'sourceUrl', 'platform', 'notes', 'releasePageUrl', 'githubUrl',
  'patchType', 'patchFilename', 'patchSha1',
  'baseRomId',
  ...MAPPING_FIELD_KEYS,
] as const;

const changeRequestSchema = z.object({
  // Only checks that every key present is a real editable field — whether
  // SOMETHING was actually proposed (this, tags, or a family change) is
  // checked below, across all three together. Previously this alone
  // required changes to be non-empty, which meant a request couldn't
  // propose ONLY a tag change or ONLY a family change without also
  // tweaking an unrelated field just to pass validation — tightened
  // incidentally while adding proposedFamily below, since "just fix the
  // family grouping, nothing else" is a completely normal request to want
  // to make on its own.
  changes: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).refine(
    (obj) => Object.keys(obj).every((k) => (EDITABLE_FIELDS as readonly string[]).includes(k)),
    { message: 'changes contains an invalid field' }
  ),
  reason: z.string().max(1000).optional(),
  // Whether an approved hackName/author/releaseYear/releaseDate/description change here
  // should fan out to every other version of this hack, or apply to just
  // this submission. Set by the requester; the approve action honors it
  // as-is. Defaults true — "these should match unless told otherwise".
  applyToAllVersions: z.boolean().optional(),
  // Proposed tag slugs, full-replace semantics on approval — same idea as
  // the direct-edit PATCH route's tags handling, just deferred until an
  // admin approves. Omit entirely to propose no tag change; an empty array
  // explicitly proposes clearing all tags (these are different things).
  // Validated with .refine() + .includes() rather than z.enum(ALL_TAG_SLUGS)
  // — that would need casting the mapped-not-const-tuple ALL_TAG_SLUGS to a
  // zod-enum-shaped tuple type, an assertion not otherwise used/proven
  // anywhere else in this codebase; .includes() against an `as readonly
  // string[]`-cast array is the pattern already proven safe elsewhere here
  // (e.g. check-similar-name's platform check).
  proposedTags: z.array(z.string()).refine(
    (arr) => arr.every((s) => (ALL_TAG_SLUGS as readonly string[]).includes(s)),
    { message: 'Contains an invalid tag slug' }
  ).optional(),
  // Same null-vs-present idea as proposedTags, against LANGUAGE_CODES
  // instead of tag slugs. Currently only ever sent by the duplicate-hash-
  // resubmission path in SubmitForm.tsx — see EDITABLE_FIELDS-gap-style
  // note on the schema field itself (prisma/schema.prisma).
  proposedTranslationLanguages: z.array(z.string()).refine(
    (arr) => arr.every((c) => (LANGUAGE_CODES as readonly string[]).includes(c)),
    { message: 'Contains an unrecognized language code' }
  ).optional(),
  // Proposed hack-family reassignment — same null-vs-present idea as
  // proposedTags: omit entirely to propose no family change, or send an
  // object (id: null proposes detaching; id: 'xyz' proposes joining that
  // family) to propose one. `name` is a display-only snapshot from
  // whatever the picker's search already returned — re-validated against
  // the live family by id below, never trusted on its own.
  proposedFamily: z.object({
    id: z.string().nullable(),
    name: z.string().nullable(),
  }).optional(),
}).refine(
  (data) => Object.keys(data.changes).length > 0 || data.proposedTags !== undefined || data.proposedTranslationLanguages !== undefined || data.proposedFamily !== undefined,
  { message: 'Propose at least one change — a field edit, a tag change, or a family change' }
);

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (session.user.isBanned) {
    return NextResponse.json({ error: 'Your account has been banned' }, { status: 403 });
  }

  const submission = await prisma.submission.findUnique({ where: { id: params.id } });
  if (!submission) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const body = await req.json();
  const parsed = changeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 });
  }

  // Validate a proposed family reassignment eagerly, against whichever
  // platform would actually be in effect (the proposed new one, if a
  // platform change is ALSO part of this same request, otherwise the
  // submission's current one) — so a contributor finds out immediately if
  // their pick doesn't fit, rather than an admin discovering it only when
  // trying to approve days later. The approval-time application still
  // re-validates independently (reassignSubmissionFamily in
  // src/lib/hackFamily.ts) since the platform or the target family could
  // change in the meantime — this is a courtesy check, not the only guard.
  if (parsed.data.proposedFamily?.id) {
    const effectivePlatform = typeof parsed.data.changes.platform === 'string' ? parsed.data.changes.platform : submission.platform;
    const target = await prisma.hackFamily.findUnique({ where: { id: parsed.data.proposedFamily.id } });
    if (!target) {
      return NextResponse.json({ error: 'That family no longer exists' }, { status: 422 });
    }
    if (target.platform !== effectivePlatform) {
      return NextResponse.json(
        { error: `That family is for ${target.platform}, not ${effectivePlatform} — families are platform-specific.` },
        { status: 422 }
      );
    }
  }

  const changeRequest = await prisma.changeRequest.create({
    data: {
      submissionId: params.id,
      requestedById: session.user.id,
      changes: stripMappingValues(parsed.data.changes as Record<string, unknown>) as any,
      reason: parsed.data.reason,
      applyToAllVersions: parsed.data.applyToAllVersions ?? true,
      proposedTags: parsed.data.proposedTags !== undefined ? (parsed.data.proposedTags as any) : undefined,
      proposedTranslationLanguages: parsed.data.proposedTranslationLanguages !== undefined ? (parsed.data.proposedTranslationLanguages as any) : undefined,
      proposedFamily: parsed.data.proposedFamily !== undefined ? (parsed.data.proposedFamily as any) : undefined,
    },
    include: {
      requestedBy: { select: { id: true, name: true, image: true } },
    },
  });

  await prisma.auditLog.create({
    data: {
      action: 'CHANGE_REQUEST_SUBMITTED',
      details: {
        changes: parsed.data.changes,
        reason: parsed.data.reason,
        applyToAllVersions: parsed.data.applyToAllVersions ?? true,
        proposedTags: parsed.data.proposedTags,
        proposedTranslationLanguages: parsed.data.proposedTranslationLanguages,
        proposedFamily: parsed.data.proposedFamily,
      },
      userId: session.user.id,
      submissionId: params.id,
    },
  });

  return NextResponse.json(changeRequest, { status: 201 });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const requests = await prisma.changeRequest.findMany({
    where: { submissionId: params.id },
    include: {
      requestedBy: { select: { id: true, name: true, image: true } },
      reviewedBy: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json(requests);
}
