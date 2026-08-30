// src/app/api/entries/hack-family/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { toISODateOnly } from '@/lib/hackFamily';

// GET /api/entries/hack-family/[id]
//
// Full prefill payload for a specific hack family — used by the submit
// form (src/components/SubmitForm.tsx) when a hack name is resolved to an
// existing family, either by explicitly picking an autocomplete suggestion
// or because a parsed filename turned out to be an exact match. Deliberately
// separate from GET /api/submissions/check-similar-name, which is scoped
// by name+platform and used for the "did you mean" near-match flow — this
// one is scoped by an already-known family id (unambiguous regardless of
// whether platform has even been picked yet) and returns more: game
// database links aren't tracked on HackFamily at all (they live on
// GameMapping, one per Submission), so this pulls them from whichever
// member of the family actually has a GameMapping set, alongside the
// family's own author/releaseYear/releaseDate/description/tags. Public — same
// visibility level as the rest of the browse-facing entries endpoints, no
// auth required.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const family = await prisma.hackFamily.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      name: true,
      platform: true,
      author: true,
      releaseYear: true,
      releaseDate: true,
      description: true,
      submissions: {
        where: { deletedAt: null },
        select: {
          updatedAt: true,
          gameMapping: true,
          tags: { select: { tag: { select: { slug: true } } } },
        },
      },
    },
  });

  if (!family) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Prefer a member that actually has game-database links set; otherwise
  // fall back to whichever member was touched most recently for tags.
  const withMapping = family.submissions.filter((s) => s.gameMapping);
  const mappingSource = withMapping.length > 0
    ? [...withMapping].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]
    : null;
  const tagSource = [...family.submissions].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];

  const m = mappingSource?.gameMapping;

  return NextResponse.json({
    name: family.name,
    platform: family.platform,
    author: family.author,
    releaseYear: family.releaseYear,
    releaseDate: toISODateOnly(family.releaseDate),
    description: family.description,
    tags: tagSource?.tags.map((t) => t.tag.slug) ?? [],
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
  });
}
