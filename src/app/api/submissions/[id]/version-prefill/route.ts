// src/app/api/submissions/[id]/version-prefill/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// GET /api/submissions/:id/version-prefill
//
// Powers the "Add new version" button on a submission's own detail page
// (src/app/submissions/[id]/page.tsx, next to the version switcher) — that
// button links to /submit?fromSubmission=<id>, and SubmitForm.tsx calls
// this route on load to pre-fill the new-version form from THIS specific
// submission.
//
// Deliberately separate from GET /api/entries/hack-family/[id] (which
// SubmitForm already uses for the family-wide author/releaseYear/
// releaseDate/description/tags/game-database-link prefill triggered by a
// plain name match): that route aggregates across every member of a
// family and only ever returns the handful of fields HackFamily actually
// tracks. This route is scoped to one exact submission instead, and
// additionally covers the several genuinely per-version fields that route
// was never meant to answer for — source URL, notes, release page/GitHub
// URLs, patch details, and the base ROM — copied from THIS submission
// specifically, not aggregated/guessed across the family.
//
// Deliberately does NOT return version, versionChangelog, releaseYear, or
// releaseDate — those are exactly the fields expected to be different for
// a new version, so the "add new version" flow leaves them blank rather
// than quietly carrying over a value that's likely wrong for the new one.
// (SubmitForm.tsx additionally suppresses its own, separate
// family-match-triggered release-date prefill for the duration of this
// flow — see skipDatePrefillRef there — since a same-name/platform match
// against the existing family would otherwise fill it back in anyway.)
//
// Public, no auth required — same visibility model as the hack-family
// route above; the only gate is the standard soft-delete-hides-from-
// non-admins rule every other submission-reading endpoint in this project
// already applies.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  const isAdmin = session?.user?.role === 'ADMINISTRATOR';

  const submission = await prisma.submission.findUnique({
    where: { id: params.id },
    select: {
      hackName: true,
      platform: true,
      author: true,
      description: true,
      sourceUrl: true,
      notes: true,
      releasePageUrl: true,
      githubUrl: true,
      patchType: true,
      patchFilename: true,
      patchSha1: true,
      translationLanguages: true,
      deletedAt: true,
      tags: { select: { tag: { select: { slug: true } } } },
      gameMapping: true,
      baseRom: { select: { id: true, name: true, status: true, fileExtension: true } },
    },
  });

  if (!submission) {
    return NextResponse.json({ error: 'Submission not found' }, { status: 404 });
  }

  // Same rule as GET /api/submissions/[id] and the detail page itself — a
  // soft-deleted submission isn't something to prefill a new version from
  // unless you're an admin.
  if (submission.deletedAt && !isAdmin) {
    return NextResponse.json({ error: 'Submission not found' }, { status: 404 });
  }

  const m = submission.gameMapping;

  return NextResponse.json({
    hackName: submission.hackName,
    platform: submission.platform,
    author: submission.author,
    description: submission.description,
    sourceUrl: submission.sourceUrl,
    notes: submission.notes,
    releasePageUrl: submission.releasePageUrl,
    githubUrl: submission.githubUrl,
    patchType: submission.patchType,
    patchFilename: submission.patchFilename,
    patchSha1: submission.patchSha1,
    translationLanguages: submission.translationLanguages,
    tags: submission.tags.map((t: { tag: { slug: string } }) => t.tag.slug),
    gameDatabaseLinks: m
      ? {
          igdbId: m.igdbId ?? undefined,
          theGamesDBId: m.theGamesDBId ?? undefined,
          launchboxId: m.launchboxId ?? undefined,
          giantBombId: m.giantBombId ?? undefined,
          screenScraperId: m.screenScraperId ?? undefined,
          steamGridDBId: m.steamGridDBId ?? undefined,
          retroAchievementsId: m.retroAchievementsId ?? undefined,
          steamId: m.steamId ?? undefined,
          gogId: m.gogId ?? undefined,
          epicGamesId: m.epicGamesId ?? undefined,
          wikipediaUrl: m.wikipediaUrl ?? undefined,
        }
      : null,
    baseRom: submission.baseRom
      ? {
          id: submission.baseRom.id,
          name: submission.baseRom.name,
          status: submission.baseRom.status,
          fileExtension: submission.baseRom.fileExtension,
        }
      : null,
  });
}
