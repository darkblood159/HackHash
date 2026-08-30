// src/app/api/admin/import/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { PLATFORMS } from '@/types';
import { ensureTagsExist } from '@/lib/tags';
import { LANGUAGE_CODES } from '@/lib/languages';
import { stripMappingValues } from '@/lib/mappingFields';
import { resolveOrCreateFamily, resolveReleaseFields } from '@/lib/hackFamily';
import { resolveOrCreateBaseRom } from '@/lib/baseRom';

const MAX_ENTRIES = 5000;

const gameDatabaseLinksSchema = z.object({
  igdbId: z.string().max(100).optional(),
  igdbSlug: z.string().max(200).optional(),
  theGamesDBId: z.string().max(100).optional(),
  launchboxId: z.string().max(100).optional(),
  giantBombId: z.string().max(100).optional(),
  screenScraperId: z.string().max(100).optional(),
  steamGridDBId: z.string().max(100).optional(),
  retroAchievementsId: z.string().max(100).optional(),
  steamId: z.string().max(100).optional(),
  gogId: z.string().max(100).optional(),
  epicGamesId: z.string().max(100).optional(),
  wikipediaUrl: z.string().max(500).optional(),
  canonicalName: z.string().max(300).optional(),
  hasheousId: z.string().max(100).optional(),
});

const entrySchema = z.object({
  hackName: z.string().min(1).max(300),
  version: z.string().min(1).max(50),
  machineName: z.string().min(1).max(300),
  description: z.string().max(300).optional(),
  romName: z.string().min(1).max(500),
  size: z.string().regex(/^\d+$/),
  crc32: z.string().regex(/^[0-9a-f]{8}$/i),
  md5: z.string().regex(/^[0-9a-f]{32}$/i),
  sha1: z.string().regex(/^[0-9a-f]{40}$/i),
  // Everything below is optional and only ever present when re-importing
  // our own "detailed" export (see src/lib/dat-generator.ts / dat-parser.ts)
  // — absent for a plain DAT XML or lean JSON source, which is fine, all of
  // it is optional.
  author: z.string().max(200).optional(),
  versionChangelog: z.string().max(3000).optional(),
  releaseYear: z.number().int().min(1990).max(new Date().getFullYear() + 1).optional(),
  releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  realDescription: z.string().max(5000).optional(),
  tags: z.array(z.string()).max(20).optional(), // cap raised alongside the tags overhaul — see submissions/route.ts's matching comment
  translationLanguages: z.array(z.string()).max(10).optional(),
  patchType: z.enum(['IPS', 'BPS', 'UPS', 'XDELTA', 'PPF', 'APS']).optional(),
  patchFilename: z.string().max(500).optional(),
  patchSha1: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
  baseRom: z.object({
    name: z.string().min(1).max(300),
    platform: z.string(), // validated against PLATFORMS at use time; falls back to the entry's own platform if it doesn't match
    crc32: z.string().regex(/^[0-9a-f]{8}$/i),
    md5: z.string().regex(/^[0-9a-f]{32}$/i),
    sha1: z.string().regex(/^[0-9a-f]{40}$/i),
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  }).optional(),
  sourceUrl: z.string().url().max(1000).optional(),
  releasePageUrl: z.string().url().max(1000).optional(),
  githubUrl: z.string().url().max(1000).optional(),
  notes: z.string().max(5000).optional(),
  gameDatabaseLinks: gameDatabaseLinksSchema.optional(),
  // The hack-family this entry belonged to in the source database, present
  // only for a "detailed" export re-import — see src/lib/hackFamily.ts and
  // src/lib/dat-parser.ts. Matched by name + platform, not trusted as an
  // id (a fresh import always creates new HackFamily rows).
  hackFamily: z.object({
    name: z.string().min(1).max(300),
    author: z.string().max(200).optional(),
    releaseYear: z.number().int().min(1990).max(new Date().getFullYear() + 1).optional(),
    releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    description: z.string().max(5000).optional(),
  }).optional(),
});

const importSchema = z.object({
  importId: z.string().optional(), // present on every batch after the first
  platform: z.enum(PLATFORMS),
  note: z.string().max(500).optional(),
  sourceFilename: z.string().max(300).nullable().optional(),
  sourceFileSizeBytes: z.number().int().nonnegative().optional(),
  totalParsed: z.number().int().nonnegative().optional(), // total across ALL batches, sent once on the first call
  entries: z.array(entrySchema).min(1).max(MAX_ENTRIES),
});

const CHUNK_SIZE = 25;

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = importSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 });
  }

  const { platform, note, sourceFilename, sourceFileSizeBytes, totalParsed, entries } = parsed.data;
  let { importId } = parsed.data;

  // First batch of an import creates the DatImport row; subsequent batches
  // (identified by importId) append to it instead of creating a new one.
  if (!importId) {
    const created = await prisma.datImport.create({
      data: {
        filename: sourceFilename ?? 'unknown.dat',
        fileSizeBytes: sourceFileSizeBytes,
        platform,
        note,
        totalParsed: totalParsed ?? entries.length,
        importedById: session.user.id,
      },
    });
    importId = created.id;
  } else {
    const existing = await prisma.datImport.findUnique({ where: { id: importId } });
    if (!existing) {
      return NextResponse.json({ error: 'Unknown importId' }, { status: 404 });
    }
  }

  let imported = 0;
  let skippedDuplicates = 0;
  const errors: Array<{ machineName: string; error: string }> = [];
  // AUG-28: duplicates used to record only {machineName, sha1, reason} — the
  // exact same three fields regardless of what was actually already there,
  // and none of it ever got shown anywhere in the UI besides an aggregate
  // count either (see ImportDatForm.tsx / the history page — both only
  // ever displayed "N skipped", never which entries or why). That made a
  // legitimate "this one really was already in the database" skip
  // indistinguishable, from the admin's side, from an actual bug — there
  // was no way to check without going and searching the site by hand for
  // that exact SHA-1. Now also captures the id/name/status of whatever it
  // actually collided with, and the two files below (this route +
  // ImportDatForm.tsx) surface it.
  const skippedEntries: Array<{
    machineName: string;
    sha1: string;
    reason: string;
    existingSubmissionId?: string;
    existingHackName?: string;
    existingStatus?: string;
  }> = [];

  const noteText = [
    `Imported from DAT${sourceFilename ? ` "${sourceFilename}"` : ''} on ${new Date().toISOString().split('T')[0]} by ${session.user.name ?? 'admin'}.`,
    note,
  ].filter(Boolean).join(' ');

  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    const chunk = entries.slice(i, i + CHUNK_SIZE);

    await Promise.all(
      chunk.map(async (entry) => {
        const sha1 = entry.sha1.toLowerCase();
        const md5 = entry.md5.toLowerCase();
        const crc32 = entry.crc32.toLowerCase();

        try {
          const existingSub = await prisma.submission.findFirst({
            where: { sha1, status: { not: 'REJECTED' } },
            // AUG-29 FIX: Submission's display-name field is `hackName`, not
            // `machineName` — `machineName` is a real field, just on a
            // DIFFERENT model (ApprovedEntry, the collision-suffixed
            // internal identifier used post-approval, deliberately never
            // shown as a display name — see its own field comment). Caught
            // by the user's own `npm run build`, not by esbuild — exactly
            // the gap this project's own esbuild-isn't-a-type-checker
            // convention warns about; wrote it wrong here specifically
            // because `entry.machineName` (a genuinely correct field, on
            // the PARSED DAT ENTRY type, unrelated to either Submission
            // field above) was right there in the same function and the
            // name carried over by mistake.
            select: { id: true, hackName: true, status: true },
          });
          if (existingSub) {
            skippedDuplicates++;
            skippedEntries.push({
              machineName: entry.machineName,
              sha1,
              reason: 'Duplicate — SHA-1 already exists',
              existingSubmissionId: existingSub.id,
              existingHackName: existingSub.hackName,
              existingStatus: existingSub.status,
            });
            return;
          }

          let fileSize: bigint;
          try {
            fileSize = BigInt(entry.size);
          } catch {
            errors.push({ machineName: entry.machineName, error: 'Invalid file size' });
            skippedEntries.push({ machineName: entry.machineName, sha1, reason: 'Invalid file size' });
            return;
          }

          await prisma.$transaction(async (tx) => {
            // Per-entry notes (from a detailed-export re-import) are
            // combined with, not overwritten by, the batch attribution —
            // neither should be lost.
            const combinedNotes = [entry.notes, noteText].filter(Boolean).join(' — ');

            // Same derive-from-whichever-was-sent safety net as the live
            // submit/edit routes — guards against a hand-edited export file
            // where releaseDate/releaseYear might not actually agree.
            const release = resolveReleaseFields({ releaseDate: entry.releaseDate ?? null, releaseYear: entry.releaseYear ?? null });

            const submission = await tx.submission.create({
              data: {
                hackName: entry.hackName,
                version: entry.version,
                platform,
                filename: entry.romName,
                fileSize,
                crc32,
                md5,
                sha1,
                notes: combinedNotes,
                status: 'APPROVED',
                submittedById: session.user.id,
                datImportId: importId,
                author: entry.author || null,
                versionChangelog: entry.versionChangelog || null,
                translationLanguages: (entry.translationLanguages ?? []).filter((c) => LANGUAGE_CODES.includes(c)),
                releaseYear: release.releaseYear,
                releaseDate: release.releaseDate,
                description: entry.realDescription || null,
                sourceUrl: entry.sourceUrl || null,
                releasePageUrl: entry.releasePageUrl || null,
                githubUrl: entry.githubUrl || null,
                patchType: entry.patchType || null,
                patchFilename: entry.patchFilename || null,
                patchSha1: entry.patchSha1?.toLowerCase() || null,
              },
            });

            await tx.approvedEntry.create({
              data: {
                submissionId: submission.id,
                machineName: entry.machineName,
                description: entry.description || entry.machineName,
                romName: entry.romName,
                platform,
                fileSize,
                crc32,
                md5,
                sha1,
                approvedById: session.user.id,
              },
            });

            // Group with any other version of the same hack — prefers the
            // source database's own family name (a detailed-export
            // re-import) over this entry's own hackName, so versions that
            // had diverged from their family's canonical name (an edit made
            // with "apply to all versions" unchecked) still regroup
            // correctly. Deliberately does NOT propagate shared fields to
            // any existing siblings here (unlike the single-submission
            // create route) — up to CHUNK_SIZE entries import concurrently,
            // and several could resolve to the same family in one chunk;
            // grouping is safe under that (resolveOrCreateFamily already
            // handles the create-race), syncing values concurrently isn't
            // worth the added risk for a bulk path. Run a normal edit
            // afterward if the group's fields should actually match.
            const familyRelease = resolveReleaseFields({
              releaseDate: entry.hackFamily?.releaseDate ?? release.releaseDate ?? null,
              releaseYear: entry.hackFamily?.releaseYear ?? release.releaseYear ?? null,
            });
            const { familyId } = await resolveOrCreateFamily(
              tx,
              {
                name: entry.hackFamily?.name ?? entry.hackName,
                platform,
                author: entry.hackFamily?.author ?? entry.author ?? null,
                releaseYear: familyRelease.releaseYear,
                releaseDate: familyRelease.releaseDate,
                description: entry.hackFamily?.description ?? entry.realDescription ?? null,
              },
              true // tx here is an open prisma.$transaction — see resolveOrCreateFamily's inTransaction param
            );
            await tx.submission.update({ where: { id: submission.id }, data: { hackFamilyId: familyId } });

            // Base rom — only present for a detailed-export re-import
            // (entry.baseRom); a plain DAT/lean-JSON import has no base rom
            // concept at all, so this is simply skipped for those, same as
            // it would be for anything imported before this feature existed.
            // Preserves the source database's approval status (status)
            // rather than resetting an already-approved base rom back to
            // pending — that's the whole point of round-tripping it through
            // the export in the first place. Uses PLATFORMS.includes as a
            // defensive check on entry.baseRom.platform since it came from
            // an uploaded file, not a validated form.
            if (entry.baseRom) {
              const baseRomPlatform = (PLATFORMS as readonly string[]).includes(entry.baseRom.platform)
                ? entry.baseRom.platform
                : platform;
              const { baseRomId } = await resolveOrCreateBaseRom(
                tx,
                {
                  platform: baseRomPlatform,
                  name: entry.baseRom.name,
                  crc32: entry.baseRom.crc32,
                  md5: entry.baseRom.md5,
                  sha1: entry.baseRom.sha1,
                  status: (entry.baseRom.status as 'PENDING' | 'APPROVED' | 'REJECTED') ?? 'APPROVED',
                  submittedById: session.user.id,
                  approvedById: entry.baseRom.status !== 'PENDING' ? session.user.id : null,
                  approvedAt: entry.baseRom.status !== 'PENDING' ? new Date() : null,
                },
                true // tx here is an open prisma.$transaction — see resolveOrCreateBaseRom's inTransaction param
              );
              await tx.submission.update({ where: { id: submission.id }, data: { baseRomId } });
            }

            // Tags — same self-healing resolution as everywhere else tags
            // are written (see src/lib/tags.ts), so an unseeded database
            // can't silently drop them here either.
            if (entry.tags?.length) {
              const tagRows = await ensureTagsExist(tx, entry.tags);
              if (tagRows.length) {
                await tx.submissionTag.createMany({
                  data: tagRows.map((t) => ({ submissionId: submission.id, tagId: t.id })),
                });
              }
            }

            // Game database links — only create a GameMapping row if at
            // least one link is actually present, same rule as the manual
            // submit form and admin edit use.
            if (entry.gameDatabaseLinks) {
              const mappingData = stripMappingValues({
                igdbId: entry.gameDatabaseLinks.igdbId || null,
                igdbSlug: entry.gameDatabaseLinks.igdbSlug || null,
                theGamesDBId: entry.gameDatabaseLinks.theGamesDBId || null,
                launchboxId: entry.gameDatabaseLinks.launchboxId || null,
                giantBombId: entry.gameDatabaseLinks.giantBombId || null,
                screenScraperId: entry.gameDatabaseLinks.screenScraperId || null,
                steamGridDBId: entry.gameDatabaseLinks.steamGridDBId || null,
                retroAchievementsId: entry.gameDatabaseLinks.retroAchievementsId || null,
                steamId: entry.gameDatabaseLinks.steamId || null,
                gogId: entry.gameDatabaseLinks.gogId || null,
                epicGamesId: entry.gameDatabaseLinks.epicGamesId || null,
                wikipediaUrl: entry.gameDatabaseLinks.wikipediaUrl || null,
                canonicalName: entry.gameDatabaseLinks.canonicalName || null,
                hasheousId: entry.gameDatabaseLinks.hasheousId || null,
              });
              const hasAnyMapping = Object.values(mappingData).some(Boolean);
              if (hasAnyMapping) {
                const mapping = await tx.gameMapping.create({ data: mappingData });
                await tx.submission.update({ where: { id: submission.id }, data: { gameMappingId: mapping.id } });
              }
            }

            await tx.auditLog.create({
              data: {
                action: 'SUBMISSION_BULK_IMPORTED',
                details: { machineName: entry.machineName, sourceFilename: sourceFilename ?? null, importId },
                userId: session.user.id,
                submissionId: submission.id,
              },
            });
          });

          imported++;
        } catch (err: any) {
          const reason = err?.code === 'P2002' ? 'An entry with this name already exists in the DAT' : 'Unexpected error creating entry';
          errors.push({ machineName: entry.machineName, error: reason });
          skippedEntries.push({ machineName: entry.machineName, sha1, reason });
        }
      })
    );
  }

  // Append this batch's results onto the DatImport row
  const current = await prisma.datImport.findUnique({ where: { id: importId }, select: { skippedLog: true } });
  const existingLog = Array.isArray(current?.skippedLog) ? (current!.skippedLog as any[]) : [];

  await prisma.datImport.update({
    where: { id: importId },
    data: {
      importedCount: { increment: imported },
      skippedDuplicates: { increment: skippedDuplicates },
      errorCount: { increment: errors.length },
      skippedLog: [...existingLog, ...skippedEntries] as any,
    },
  });

  return NextResponse.json({ importId, imported, skippedDuplicates, errors, skippedEntries });
}
