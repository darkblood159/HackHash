// src/app/api/admin/hack-families/search/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { normalizeNameKey, relevanceScore } from '@/lib/hackFamily';
import { PLATFORMS } from '@/types';

// GET /api/admin/hack-families/search?platform=&q=&excludeFamilyId=
//
// Powers the family-reassignment picker in the approval menu
// (src/components/FamilyPicker.tsx, used from AdminActions.tsx) — lets an
// admin find an EXISTING family on the same platform to move a pending
// submission into before approving it. Deliberately admin-only and separate
// from the public GET /api/entries/autocomplete: that endpoint only
// surfaces families with at least one publicly-visible approved entry
// (it's a browse suggestion), where this one needs to surface ANY family on
// the platform — a pending submission may belong with a group that's still
// entirely pending review itself.
//
// `q` is optional — an empty query returns a first batch of families for
// the platform (alphabetical) so the picker has something to show as soon
// as it opens, same "browse before you type" pattern as BaseRomPicker's
// "select existing" tab.
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const platformParam = searchParams.get('platform');
  const platform = platformParam && (PLATFORMS as readonly string[]).includes(platformParam) ? platformParam : null;
  if (!platform) {
    return NextResponse.json({ error: 'A valid platform is required' }, { status: 422 });
  }
  const q = searchParams.get('q')?.trim() ?? '';
  const excludeFamilyId = searchParams.get('excludeFamilyId') || undefined;

  const families = await prisma.hackFamily.findMany({
    where: {
      platform: platform as any,
      ...(excludeFamilyId ? { id: { not: excludeFamilyId } } : {}),
      ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
    },
    select: { id: true, name: true, _count: { select: { submissions: true } } },
    take: 50, // over-fetch a bit when ranking by relevance; capped below either way
    orderBy: { name: 'asc' },
  });

  let results: Array<{ id: string; name: string; versionCount: number }>;
  if (q) {
    const normalized = normalizeNameKey(q);
    results = families
      .map((f) => ({ id: f.id, name: f.name, versionCount: f._count.submissions, score: relevanceScore(f.name, normalized) }))
      .filter((f) => f.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .map(({ id, name, versionCount }) => ({ id, name, versionCount }));
  } else {
    results = families.map((f) => ({ id: f.id, name: f.name, versionCount: f._count.submissions }));
  }

  return NextResponse.json({ families: results.slice(0, 10) });
}
