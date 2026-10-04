// src/lib/submissionCreate.ts
//
// The creation logic behind POST /api/submissions, moved out of that route
// (Sep 29 2026) so the bulk-submit flow can call the exact same code path
// instead of growing a second copy of it — this project has been bitten
// more than once by two hand-maintained copies of "the rules" drifting apart
// (see CLAUDE_HANDOFF.txt section 4). Everything below the schema is the
// route's former body, moved as-is; the route now keeps only what is
// specific to an HTTP request (session/ban/trust gate, the rate limit, JSON
// parsing) and maps SubmissionCreateError to a response.
//
// ONE deliberate behavior change vs. the old inline version, and only one:
// the base ROM is now checked with validateBaseRomAssignment() (platform
// match + not REJECTED) instead of an existence-only lookup — see the
// comment at that call.
//
// Bulk submit (added after that move) reuses this function unchanged for the
// ordinary path and adds ONE optional argument, `opts.batchId`. When it's
// absent — every single-form submission — nothing below behaves differently.
// When present the caller (POST /api/submissions) has ALREADY verified the
// batch belongs to the caller and is still open; this function then
// enforces the rules that belong with the data itself (see
// enforceBatchRules) and stamps the id on the row.
//
// Deliberately NOT wrapped in a transaction, exactly like the code it was
// moved from: the writes below are sequential on purpose (a failed
// best-effort sync must not fail an already-created submission — see the
// try/catch around the family sync). Changing that is a separate decision.

import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { PLATFORMS } from '@/types';
import { stripMappingValues } from '@/lib/mappingFields';
import { ensureTagsExist } from '@/lib/tags';
import { LANGUAGE_CODES } from '@/lib/languages';
import { resolveOrCreateFamily, propagateSharedFields, propagateTags, resolveReleaseFields } from '@/lib/hackFamily';
import { validateBaseRomAssignment, BaseRomAssignError } from '@/lib/baseRom';
import { validateFranchiseAssignment, propagateFranchise, FranchiseAssignError } from '@/lib/franchise';
import { validateAuthorAssignment, propagateAuthor, AuthorAssignError, type AuthorSummary } from '@/lib/author';
import { getBulkLimitsForUser, countBatchRows, BatchError } from '@/lib/submissionBatch';
import { describeIsBaseRom, versionKey } from '@/lib/bulkChecks';

export const createSubmissionSchema = z.object({
  hackName: z.string().min(1).max(200),
  version: z.string().min(1).max(50),
  description: z.string().max(5000).optional(),
  versionChangelog: z.string().max(3000).optional(),
  // Free-text fallback, used only when authorId (below) isn't sent —
  // author linking through the shared Author list is the primary path
  // going forward (see SubmitForm's AuthorPicker), but this stays accepted
  // for anything hitting this API directly without going through that
  // picker. Ignored (overridden server-side) whenever authorId IS present
  // — see the authorId handling below for why.
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
  patchType: z.enum(['IPS', 'BPS', 'UPS', 'XDELTA', 'PPF', 'APS', 'OTHER']).optional(),
  patchFilename: z.string().max(500).optional(),
  patchSha1: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
  // Required — every submission needs a base rom reference. References an
  // EXISTING BaseRom row (see src/lib/baseRom.ts); resolving/creating a new
  // one happens via a separate call to POST /api/base-roms before the
  // submit form ever gets here, not as part of this payload.
  baseRomId: z.string().min(1, 'A base ROM is required'),
  // OPTIONAL — unlike baseRomId, a hack doesn't have to belong to a
  // franchise. References an EXISTING Franchise row (see src/lib/franchise.ts);
  // proposing a brand-new one happens via POST /api/franchises before the
  // form gets here, same as base roms via POST /api/base-roms.
  franchiseId: z.string().min(1).optional(),
  // OPTIONAL, same shape as franchiseId — references an EXISTING Author row
  // (see src/lib/author.ts); proposing a brand-new one happens via POST
  // /api/authors before the form gets here. When present, this WINS over
  // the plain `author` string above — the resolved Author row's current
  // name becomes the submission's `author` value, never whatever string
  // happened to also be sent (see Submission.authorId's schema comment for
  // why `author` has to stay an accurate cache).
  authorId: z.string().min(1).optional(),
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

export type CreateSubmissionInput = z.infer<typeof createSubmissionSchema>;

/**
 * A refusal with the HTTP status and JSON body the route should answer with.
 * `body` is kept whole (not just a message) because the duplicate-SHA1 case
 * carries a `duplicate` payload the client renders.
 */
export class SubmissionCreateError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === 'string' ? body.error : 'Submission could not be created');
    this.status = status;
    this.body = body;
  }
}

/**
 * Validates references, rejects an exact-SHA1 duplicate, then creates the
 * submission plus its tags, game mapping, and hack-family membership, writes
 * the audit log, promotes a first-time GUEST to CONTRIBUTOR, and returns the
 * created row with any potential (md5/crc32) duplicates. Throws
 * SubmissionCreateError for anything the caller should surface as a 4xx.
 *
 * `data` must already have passed createSubmissionSchema — this does not
 * re-parse. `userId` must already be an authenticated, non-banned user; the
 * auth gate and rate limit belong to the caller.
 */
export async function createSubmissionCore(
  data: CreateSubmissionInput,
  userId: string,
  opts: { batchId?: string } = {}
) {
  const batchId = opts.batchId;
  // Was an existence-only check (findUnique -> 400 "no longer exists"). Now
  // the same validateBaseRomAssignment() the edit and change-request paths
  // already use, so create also refuses a base ROM for the wrong platform or
  // one an admin already REJECTED — a gap create alone had (Aug 31 2026's
  // fix covered edit + change-request but not this path). The not-found case
  // keeps its original 400 + wording so nothing that already handled that
  // response changes; only the two NEW refusals are new behavior.
  try {
    await validateBaseRomAssignment(prisma, data.baseRomId, data.platform);
  } catch (err) {
    if (err instanceof BaseRomAssignError) {
      if (err.status === 404) {
        throw new SubmissionCreateError(400, { error: 'That base ROM no longer exists — please pick or hash one again.' });
      }
      throw new SubmissionCreateError(err.status, { error: err.message });
    }
    throw err;
  }

  if (data.franchiseId) {
    try {
      await validateFranchiseAssignment(prisma, data.franchiseId);
    } catch (err) {
      if (err instanceof FranchiseAssignError) {
        throw new SubmissionCreateError(400, { error: err.message });
      }
      throw err;
    }
  }

  // authorId: same courtesy-validate-before-writing-anywhere treatment as
  // franchiseId above. When present, authorTarget.name below is what
  // actually gets written to the submission's `author` column — the
  // resolved Author row's CURRENT name, never data.author, even if a
  // caller also sent one (see this field's own schema comment).
  let authorTarget: AuthorSummary | null = null;
  if (data.authorId) {
    try {
      authorTarget = await validateAuthorAssignment(prisma, data.authorId);
    } catch (err) {
      if (err instanceof AuthorAssignError) {
        throw new SubmissionCreateError(400, { error: err.message });
      }
      throw err;
    }
  }
  const resolvedAuthor = authorTarget ? authorTarget.name : (data.author ?? null);

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
    // Bulk submit retries: if a row's response was lost after the row WAS
    // created, pressing Retry sends the same file again and lands here. When
    // the "duplicate" is this caller's own row from this very batch, that
    // isn't a conflict — it's the row they asked for, so report it as
    // already created instead of failing. Only ever queried when a batchId
    // was given, so an ordinary submission's database calls are unchanged.
    if (batchId) {
      const mine = await prisma.submission.findFirst({
        where: { id: existing.id, batchId, submittedById: userId },
        include: { submittedBy: { select: { id: true, name: true, image: true, username: true } } },
      });
      if (mine) {
        return { submission: mine, potentialDuplicates: [], promotedToContributor: false, alreadyCreated: true as const };
      }
    }
    throw new SubmissionCreateError(409, { error: 'Duplicate SHA1 found', duplicate: existing });
  }

  if (batchId) await enforceBatchRules(batchId, userId, data.version, sha1);

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
      author: resolvedAuthor,
      authorId: authorTarget?.id ?? null,
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
      franchiseId: data.franchiseId,
      notes: data.notes,
      releasePageUrl: data.releasePageUrl || null,
      githubUrl: data.githubUrl || null,
      submittedById: userId,
      ...(batchId ? { batchId } : {}),
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
    author: resolvedAuthor,
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
          author: resolvedAuthor,
          releaseYear: release.releaseYear,
          releaseDate: release.releaseDate,
          description: data.description ?? null,
        });
        if (data.tags !== undefined) {
          const tagRows = data.tags.length ? await ensureTagsExist(tx, data.tags) : [];
          await propagateTags(tx, familyId, submission.id, tagRows.map((t) => t.id));
        }
        // Only when a franchise was actually chosen — "left blank" on this
        // form means "didn't say", not "clear it everywhere", so it never
        // wipes a franchise the other versions already have.
        if (data.franchiseId) {
          await propagateFranchise(tx, familyId, submission.id, data.franchiseId);
        }
        // Same "only when actually chosen" reasoning as franchiseId above —
        // and, unlike franchiseId, this also keeps the siblings' `author`
        // string in sync (see propagateAuthor's own comment). The generic
        // propagateSharedFields call just above already pushed the same
        // resolved name out as a plain string; this additionally links
        // each sibling's authorId so they don't just show the right name
        // but are actually linked to the same governed Author row.
        if (authorTarget) {
          await propagateAuthor(tx, familyId, submission.id, authorTarget);
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
      details: { hackName: data.hackName, sha1, md5, crc32, joinedExistingFamily: !isNewFamily, ...(batchId ? { batchId } : {}) },
      userId,
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
    where: { id: userId },
    select: { role: true },
  });

  if (currentUser?.role === 'GUEST') {
    await prisma.user.update({
      where: { id: userId },
      data: { role: 'CONTRIBUTOR' },
    });
    await prisma.auditLog.create({
      data: {
        action: 'USER_ROLE_CHANGED',
        details: { newRole: 'CONTRIBUTOR', reason: 'First submission' },
        userId,
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

  return { submission, potentialDuplicates: potentialDupes, promotedToContributor, alreadyCreated: false as const };
}

/**
 * The rules that only apply to a row created under a bulk batch, checked
 * here (not only in the UI) so a client that skips the dry-run precheck
 * can't get past them. Each maps a BatchError / rule onto a
 * SubmissionCreateError so the route answers uniformly.
 *  - the batch's row cap, counted from the DATABASE (the rate limiter is a
 *    no-op when Upstash isn't configured, so it can't be the only cap);
 *  - one label per version inside a batch;
 *  - the file must not BE a base ROM (they dropped the unpatched game).
 * The exact-SHA-1-duplicate rule is the same one every submission already
 * gets, so it isn't repeated here.
 */
async function enforceBatchRules(batchId: string, userId: string, version: string, sha1: string) {
  try {
    const limits = await getBulkLimitsForUser(userId);
    const used = await countBatchRows(batchId);
    if (used >= limits.maxRows) {
      throw new SubmissionCreateError(429, {
        error: `This batch already has ${used} versions, which is the most your account can add at once. Start a new batch, or submit the rest one at a time.`,
      });
    }
  } catch (err) {
    if (err instanceof BatchError) throw new SubmissionCreateError(err.status, { error: err.message });
    throw err;
  }

  const inBatch = await prisma.submission.findMany({ where: { batchId }, select: { version: true } });
  if (inBatch.some((row) => versionKey(row.version) === versionKey(version))) {
    throw new SubmissionCreateError(409, {
      error: `A version labelled "${version.trim()}" is already in this batch — each version in a batch needs its own label.`,
    });
  }

  const asBase = await prisma.baseRom.findUnique({ where: { sha1 }, select: { name: true } });
  if (asBase) {
    throw new SubmissionCreateError(422, { error: describeIsBaseRom(asBase.name) });
  }
}
