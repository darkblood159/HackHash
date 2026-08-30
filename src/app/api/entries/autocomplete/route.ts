// src/app/api/entries/autocomplete/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { normalizeNameKey, relevanceScore } from '@/lib/hackFamily';
import { PLATFORMS } from '@/types';

// GET /api/entries/autocomplete?q=...&platform=...
//
// Powers the live typeahead dropdown (src/components/EntriesSearchBox.tsx)
// — NOT the same thing as the full search results panel
// (src/components/SearchInterface.tsx / src/app/api/search/route.ts).
// That one shows detailed result cards after a debounced fetch; this one
// returns a short list of bare hack NAMES (one per family, not one per
// version) meant to render as a compact suggestion list while someone is
// still mid-typing, closer to a classic search-bar autocomplete.
//
// Suggests HackFamily names rather than raw ApprovedEntry rows — matches
// the rest of the "one entry per hack" work (section 2c), and only
// families with at least one publicly-visible approved version (not
// soft-deleted) are eligible, since this feeds a public-facing dropdown.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q')?.trim();
  const platformParam = searchParams.get('platform');
  const platform = platformParam && (PLATFORMS as readonly string[]).includes(platformParam) ? platformParam : undefined;

  if (!q || q.length < 2) {
    return NextResponse.json({ suggestions: [] });
  }

  const families = await prisma.hackFamily.findMany({
    where: {
      name: { contains: q, mode: 'insensitive' },
      ...(platform ? { platform: platform as any } : {}),
    },
    select: {
      id: true,
      name: true,
      platform: true,
      submissions: {
        where: { deletedAt: null, approvedEntry: { isNot: null } },
        select: { id: true, approvedEntry: { select: { approvedAt: true } } },
      },
    },
    take: 50, // over-fetch a bit; ranked and capped below
  });

  const normalized = normalizeNameKey(q);

  const suggestions = families
    .filter((f) => f.submissions.length > 0)
    .map((f) => {
      // Most recently approved version of this hack is what a suggestion
      // click should land on.
      const representative = [...f.submissions].sort(
        (a, b) => new Date(b.approvedEntry!.approvedAt).getTime() - new Date(a.approvedEntry!.approvedAt).getTime()
      )[0];
      return {
        id: f.id,
        name: f.name,
        platform: f.platform,
        submissionId: representative.id,
        score: relevanceScore(f.name, normalized),
      };
    })
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 8)
    .map(({ id, name, platform: p, submissionId }) => ({ id, name, platform: p, submissionId }));

  return NextResponse.json({ suggestions });
}
