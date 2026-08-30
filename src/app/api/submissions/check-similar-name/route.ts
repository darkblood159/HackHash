// src/app/api/submissions/check-similar-name/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { findFamilyMatches, toISODateOnly } from '@/lib/hackFamily';
import { PLATFORMS } from '@/types';

// GET /api/submissions/check-similar-name?name=...&platform=...
//
// Called by the submit form when the hackName field loses focus (same
// trigger style as check-duplicate for the ROM hash — a discrete check, not
// a live type-ahead) — tells the submitter whether this name is an exact
// match for an existing hack (this submission will be added as a new
// version of it, form prefilled from it) or a close-but-not-exact match
// (surfaced as a "did you mean…" prompt so a typo or slightly different
// phrasing doesn't silently create a second, disconnected entry for what's
// actually the same hack).
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const name = searchParams.get('name')?.trim();
  const platform = searchParams.get('platform');

  if (!name || name.length < 2 || !platform || !(PLATFORMS as readonly string[]).includes(platform)) {
    return NextResponse.json({ exactMatch: null, suggestions: [] });
  }

  const rawResult = await findFamilyMatches(prisma, name, platform as any);
  // Same plain 'YYYY-MM-DD' wire shape as every other release-date API
  // response (see toISODateOnly's own comment in hackFamily.ts) — without
  // this, NextResponse.json's default Date serialization would send a full
  // "...T00:00:00.000Z" timestamp instead, which an <input type="date">
  // can't consume directly.
  const result = {
    exactMatch: rawResult.exactMatch ? { ...rawResult.exactMatch, releaseDate: toISODateOnly(rawResult.exactMatch.releaseDate) } : null,
    suggestions: rawResult.suggestions.map((s) => ({ ...s, releaseDate: toISODateOnly(s.releaseDate) })),
  };

  if (result.exactMatch) {
    // Grab tags from whichever member of the family was touched most
    // recently, purely to prefill the submit form — not authoritative,
    // just a reasonable starting point the submitter can still change.
    const recentMember = await prisma.submission.findFirst({
      where: { hackFamilyId: result.exactMatch.id },
      orderBy: { updatedAt: 'desc' },
      select: { tags: { select: { tag: { select: { slug: true } } } } },
    });
    return NextResponse.json({
      ...result,
      exactMatch: { ...result.exactMatch, tags: recentMember?.tags.map((t) => t.tag.slug) ?? [] },
    });
  }

  return NextResponse.json(result);
}
