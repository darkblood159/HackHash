// src/app/api/submissions/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { PLATFORMS } from '@/types';
import { stripMappingValues } from '@/lib/mappingFields';
import { ensureTagsExist } from '@/lib/tags';
import { LANGUAGE_CODES } from '@/lib/languages';
import { resolveOrCreateFamily, propagateSharedFields, propagateTags, resolveReleaseFields } from '@/lib/hackFamily';

const createSubmissionSchema = z.object({
  hackName: z.string().min(1).max(200),
  version: z.string().min(1).max(50),
  description: z.string().max(5000).optional(),
  versionChangelog: z.string().max(3000).optional(),
  author: z.string().min(1).max(200).optional(),
  releaseYear: z.number().int().min(1990).max(new Date().getFullYear() + 1).optional(),
  // Full release date, when actually known — 'YYYY-MM-DD', same bounds as
  // releaseYear above. If both this and releaseYear are sent, this wins
  // and releaseYear gets re-derived from it server-side (see
  // resolveReleaseFields() in src/lib/hackFamily.ts) rather than trusting
  // the two to already agree. Leave unset (and just send releaseYear) for
  // the "I only know the year" case.
  releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be in YYYY-MM-DD format').refine((val) => {
    const d = new Date(`${val}T00:00:00Z`);
    if (isNaN(d.getTime())) return false;
    const year = d.getUTCFullYear();
    return year >= 1990 && year <= new Date().getFullYear() + 1;
  }, 'Must be a real date between 1990 and next year').optional(),
  platform: z.enum(PLATFORMS),
  sourceUrl: z.string().url(),
  filename: z.string().min(1).max(500),
  fileSize: z.number().int().positive(),
  crc32: z.string().regex(/^[0-9a-f]{8}$/i),
  md5: z.string().regex(/^[0-9a-f]{32}$/i),
  sha1: z.string().regex(/^[0-9a-f]{40}$/i),
  patchType: z.enum(['IPS', 'BPS', 'UPS', 'XDELTA', 'PPF', 'APS']).optional(),
  patchFilename: z.string().max(500).optional(),
  patchSha1: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
  // Required — every submission needs a base rom reference. References an
  // EXISTING BaseRom row (see src/lib/baseRom.ts); resolving/creating a new
  // one happens via a separate call to POST /api/base-roms before the
  // submit form ever gets here, not as part of this payload.
  baseRomId: z.string().min(1, 'A base ROM is required'),
  notes: z.string().max(5000).optional(),
  releasePageUrl: z.string().url().optional().or(z.literal('')),
  githubUrl: z.string().url().optional().or(z.literal('')),
  // Raised from 10 to 20 alongside the tags overhaul (August 2026) — the
  // fuller advanced taxonomy makes it realistic for someone to pick
  // several specific single-aspect tags on one submission (e.g. Sprite/
  // Character + Palette/Color Swap + Music/BGM + Bug Fixes) well past the
  // old cap. 20 is a soft ceiling against abuse, not a real expected max.
  tags: z.array(z.string()).max(20).optional(),
  translationLanguages: z.array(z.string()).max(10).optional(),
  // If this hackName exactly matches an existing hack (another version of
  // it), whether the author/releaseYear/releaseDate/description/tags typed here should
  // become the new shared values for every version of that hack. Defaults to
  // true — "these should match unless told otherwise". Irrelevant when this
  // submission ends up starting a brand new family (nothing to sync to yet).
  applyToAllVersions: z.boolean().optional(),
  // Game database mappings
  igdbId: z.string().max(100).optional(),
  theGamesDBId: z.string().max(100).optional(),
  launchboxId: z.string().max(100).optional(),
  steamGridDBId: z.string().max(100).optional(),
  retroAchievementsId: z.string().max(100).optional(),
  steamId: z.string().max(100).optional(),
  gogId: z.string().max(100).optional(),
  giantBombId: z.string().max(100).optional(),
  screenScraperId: z.string().max(100).optional(),
  epicGamesId: z.string().max(100).optional(),
  wikipediaUrl: z.string().url().optional().or(z.literal('')).or(z.undefined()),
});

// ─── GET /api/submissions ─────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1'));
  const perPage = Math.min(50, Math.max(1, parseInt(searchParams.get('perPage') ?? '20')));
  const status = searchParams.get('status');
  const platform = searchParams.get('platform');
  const tag = searchParams.get('tag');
  const search = searchParams.get('q');

  const where: Record<string, unknown> = {
    // Soft-deleted items are never visible through the public listing —
    // admins use the dedicated /admin/submissions?deleted=true view instead.
    deletedAt: null,
  };

  if (status) {
    where.status = status;
  }

  if (platform) {
    where.platform = platform;
  }

  if (tag) {
    where.tags = { some: { tag: { slug: tag } } };
  }

  if (search) {
    where.OR = [
      { hackName: { contains: search, mode: 'insensitive' } },
      { author: { contains: search, mode: 'insensitive' } },
      { sha1: { contains: search, mode: 'insensitive' } },
      { md5: { contains: search, mode: 'insensitive' } },
      { crc32: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [total, submissions] = await Promise.all([
    prisma.submission.count({ where }),
    prisma.submission.findMany({
      where,
      include: {
        submittedBy: { select: { id: true, name: true, image: true, username: true, trustScore: true } },
        tags: { include: { tag: true } },
        _count: { select: { verifications: true, comments: true } },
      },
      orderBy: [{ verificationScore: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  return NextResponse.json({
    items: submissions,
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  });
}

// ─── POST /api/submissions ────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (session.user.isBanned) {
    return NextResponse.json({ error: 'Your account has been banned' }, { status: 403 });
  }

  if (session.user.trustScore < -50) {
    return NextResponse.json({ error: 'Account suspended due to low trust score' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = createSubmissionSchema.safeParse(body);
  if (!parsed.success) {
    // Logged server-side (not just returned to the client) specifically so
    // this shows up directly in the terminal running `npm start` — the
    // same place build errors already get seen and pasted back, rather
    // than requiring a trip into browser devtools to read the response
    // body just to find out which field actually failed.
    console.error('POST /api/submissions validation failed:', JSON.stringify(parsed.error.flatten()));
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 });
  }

  const data = parsed.data;

  const baseRomExists = await prisma.baseRom.findUnique({ where: { id: data.baseRomId }, select: { id: true } });
  if (!baseRomExists) {
    return NextResponse.json({ error: 'That base ROM no longer exists — please pick or hash one again.' }, { status: 400 });
  }

  // Normalize hashes to lowercase
  const sha1 = data.sha1.toLowerCase();
  const md5 = data.md5.toLowerCase();
  const crc32 = data.crc32.toLowerCase();

  // Check for exact duplicate
  const existing = await prisma.submission.findFirst({
    where: { sha1, status: { not: 'REJECTED' } },
    select: { id: true, hackName: true, status: true },
  });

  if (existing) {
    return NextResponse.json(
      { error: 'Duplicate SHA1 found', duplicate: existing },
      { status: 409 }
    );
  }

  // A full date, when provided, always wins and releaseYear is derived
  // from it — see resolveReleaseFields()'s own comment in hackFamily.ts.
  const release = resolveReleaseFields({ releaseDate: data.releaseDate ?? null, releaseYear: data.releaseYear ?? null });

  const submission = await prisma.submission.create({
    data: {
      hackName: data.hackName,
      version: data.version,
      description: data.description,
      versionChangelog: data.versionChangelog,
      // Filtered against the curated list rather than trusted as-is — same
      // defense-in-depth spirit as ensureTagsExist() only ever resolving
      // known slugs. An unrecognized code is silently dropped rather than
      // erroring, since this is a soft "nice to have" field, not something
      // worth blocking a whole submission over.
      translationLanguages: (data.translationLanguages ?? []).filter((c) => LANGUAGE_CODES.includes(c)),
      author: data.author,
      releaseYear: release.releaseYear,
      releaseDate: release.releaseDate,
      platform: data.platform,
      sourceUrl: data.sourceUrl,
      filename: data.filename,
      fileSize: BigInt(data.fileSize),
      crc32,
      md5,
      sha1,
      patchType: data.patchType,
      patchFilename: data.patchFilename,
      patchSha1: data.patchSha1?.toLowerCase(),
      baseRomId: data.baseRomId,
      notes: data.notes,
      releasePageUrl: data.releasePageUrl || null,
      githubUrl: data.githubUrl || null,
      submittedById: session.user.id,
    },
    include: {
      submittedBy: { select: { id: true, name: true, image: true, username: true } },
    },
  });

  // Connect tags — ensureTagsExist creates any missing Tag row on the fly
  // (e.g. if prisma/seed.ts was never run against this database) instead of
  // silently attaching nothing, which is what happened before.
  if (data.tags?.length) {
    const tagRows = await ensureTagsExist(prisma, data.tags);
    if (tagRows.length) {
      await prisma.submissionTag.createMany({
        data: tagRows.map((t) => ({ submissionId: submission.id, tagId: t.id })),
      });
    }
  }

  // Create a GameMapping if any external IDs were provided
  const mappingFields = stripMappingValues({
    igdbId: data.igdbId || null, theGamesDBId: data.theGamesDBId || null,
    launchboxId: data.launchboxId || null, steamGridDBId: data.steamGridDBId || null,
    retroAchievementsId: data.retroAchievementsId || null, steamId: data.steamId || null,
    gogId: data.gogId || null, giantBombId: data.giantBombId || null,
    screenScraperId: data.screenScraperId || null, epicGamesId: data.epicGamesId || null,
    wikipediaUrl: data.wikipediaUrl || null,
  });
  if (Object.values(mappingFields).some(Boolean)) {
    const mapping = await prisma.gameMapping.create({ data: mappingFields });
    await prisma.submission.update({ where: { id: submission.id }, data: { gameMappingId: mapping.id } });
  }

  // Group this submission with any other versions of the same hack (exact
  // hackName + platform match). A brand new family has nothing to sync yet;
  // joining an existing one means this submission's author/releaseYear/
  // releaseDate/description/tags become the new shared values for every version, unless
  // the submitter unchecked "apply to all versions". Deliberately does NOT
  // include `name` here — resolveOrCreateFamily() only ever joins a family
  // via an EXACT nameKey match, so the family's name is already correct by
  // construction; there's nothing to rename.
  const { familyId, isNewFamily } = await resolveOrCreateFamily(prisma, {
    name: data.hackName,
    platform: data.platform,
    author: data.author ?? null,
    releaseYear: release.releaseYear,
    releaseDate: release.releaseDate,
    description: data.description ?? null,
  });
  await prisma.submission.update({ where: { id: submission.id }, data: { hackFamilyId: familyId } });

  const applyToAllVersions = data.applyToAllVersions !== false;
  if (!isNewFamily && applyToAllVersions) {
    try {
      await prisma.$transaction(async (tx) => {
        await propagateSharedFields(tx, familyId, submission.id, {
          author: data.author ?? null,
          releaseYear: release.releaseYear,
          releaseDate: release.releaseDate,
          description: data.description ?? null,
        });
        if (data.tags !== undefined) {
          const tagRows = data.tags.length ? await ensureTagsExist(tx, data.tags) : [];
          await propagateTags(tx, familyId, submission.id, tagRows.map((t) => t.id));
        }
      });
    } catch (err: any) {
      // Extremely unlikely (this only touches author/releaseYear/description,
      // none of which are unique-constrained) but don't let a sync hiccup
      // fail the whole submission — the submission itself already succeeded
      // above. Log and continue rather than 500ing something the user
      // already successfully submitted.
      console.error('Failed to sync shared fields to hack family on submission create:', err);
    }
  }

  // Audit log
  await prisma.auditLog.create({
    data: {
      action: 'SUBMISSION_CREATED',
      details: { hackName: data.hackName, sha1, md5, crc32, joinedExistingFamily: !isNewFamily },
      userId: session.user.id,
      submissionId: submission.id,
    },
  });

  // Guests become Contributors on their first submission. We check the LIVE
  // database role here, not session.user.role — that's read from the JWT and
  // can be stale (e.g. an admin promoted this user to Verifier/Admin after
  // their last login). Using the stale session value here was the bug: it
  // would silently downgrade an already-elevated user back to Contributor.
  let promotedToContributor = false;
  const currentUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true },
  });

  if (currentUser?.role === 'GUEST') {
    await prisma.user.update({
      where: { id: session.user.id },
      data: { role: 'CONTRIBUTOR' },
    });
    await prisma.auditLog.create({
      data: {
        action: 'USER_ROLE_CHANGED',
        details: { newRole: 'CONTRIBUTOR', reason: 'First submission' },
        userId: session.user.id,
      },
    });
    promotedToContributor = true;
  }

  // Check for potential duplicates (different filename/version)
  const potentialDupes = await prisma.submission.findMany({
    where: {
      id: { not: submission.id },
      OR: [
        { md5 },
        { crc32 },
      ],
      status: { not: 'REJECTED' },
    },
    select: { id: true, hackName: true, sha1: true, md5: true, crc32: true },
    take: 5,
  });

  return NextResponse.json(
    {
      submission: { ...submission, fileSize: submission.fileSize.toString() },
      potentialDuplicates: potentialDupes,
      promotedToContributor,
    },
    { status: 201 }
  );
}
