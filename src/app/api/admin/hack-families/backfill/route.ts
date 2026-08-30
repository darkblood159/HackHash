// src/app/api/admin/hack-families/backfill/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { normalizeNameKey } from '@/lib/hackFamily';

// POST /api/admin/hack-families/backfill
//
// One-time (but safe to re-run) grouping pass for submissions that predate
// the HackFamily feature. Groups every ungrouped submission by exact
// normalized hackName + platform, creating a HackFamily for each distinct
// group (or attaching to one that already exists — matters on a second run)
// and setting hackFamilyId.
//
// Deliberately does NOT overwrite any submission's own hackName/author/
// releaseYear/releaseDate/description, even within a newly-formed multi-version group —
// grouping existing entries and forcing them into agreement are different
// operations. This route only does the former, so nothing existing changes
// visibly. If you want a group's versions to actually match going forward,
// edit any one of them with "apply to all versions" checked afterward and
// it'll sync the rest.
//
// Only touches submissions with hackFamilyId still null, so it's safe to
// call again later (e.g. after a bulk DAT import adds new ungrouped rows) —
// already-grouped submissions are left alone.
export async function POST(_req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const ungrouped = await prisma.submission.findMany({
    where: { hackFamilyId: null },
    select: {
      id: true, hackName: true, platform: true, author: true, releaseYear: true, releaseDate: true,
      description: true, status: true, updatedAt: true,
    },
  });

  if (ungrouped.length === 0) {
    return NextResponse.json({
      familiesCreated: 0, submissionsGrouped: 0, groupsWithMultipleVersions: 0, multiVersionGroups: [],
    });
  }

  type Candidate = (typeof ungrouped)[number];
  const groups = new Map<string, Candidate[]>();
  for (const sub of ungrouped) {
    const key = `${normalizeNameKey(sub.hackName)}::${sub.platform}`;
    const list = groups.get(key) ?? [];
    list.push(sub);
    groups.set(key, list);
  }

  let familiesCreated = 0;
  let submissionsGrouped = 0;
  const multiVersionGroups: Array<{ name: string; platform: string; versionCount: number }> = [];

  for (const members of Array.from(groups.values())) {
    const nameKey = normalizeNameKey(members[0].hackName);
    const platform = members[0].platform;

    let family = await prisma.hackFamily.findUnique({ where: { nameKey_platform: { nameKey, platform } } });

    if (!family) {
      // Canonical snapshot for the new family: prefer an approved version
      // over a pending one, then whichever has the most of author/
      // releaseYear/description actually filled in, then most recently
      // updated. Doesn't change what any individual submission shows —
      // just picks a sensible starting point for the family row itself
      // (used e.g. to prefill the submit form for the next new version).
      const representative = [...members].sort((a, b) => {
        const approvedDiff = (b.status === 'APPROVED' ? 1 : 0) - (a.status === 'APPROVED' ? 1 : 0);
        if (approvedDiff !== 0) return approvedDiff;
        const completeness = (s: Candidate) => [s.author, s.releaseYear, s.releaseDate, s.description].filter((v) => v !== null && v !== '').length;
        const completenessDiff = completeness(b) - completeness(a);
        if (completenessDiff !== 0) return completenessDiff;
        return b.updatedAt.getTime() - a.updatedAt.getTime();
      })[0];

      family = await prisma.hackFamily.create({
        data: {
          name: representative.hackName,
          nameKey,
          platform,
          author: representative.author,
          releaseYear: representative.releaseYear,
          releaseDate: representative.releaseDate,
          description: representative.description,
        },
      });
      familiesCreated++;
    }

    await prisma.submission.updateMany({
      where: { id: { in: members.map((m) => m.id) } },
      data: { hackFamilyId: family.id },
    });
    submissionsGrouped += members.length;

    if (members.length > 1) {
      multiVersionGroups.push({ name: family.name, platform, versionCount: members.length });
    }
  }

  multiVersionGroups.sort((a, b) => b.versionCount - a.versionCount);

  await prisma.auditLog.create({
    data: {
      action: 'HACK_FAMILIES_BACKFILLED',
      details: { familiesCreated, submissionsGrouped, groupsWithMultipleVersions: multiVersionGroups.length },
      userId: session.user.id,
    },
  });

  return NextResponse.json({
    familiesCreated,
    submissionsGrouped,
    groupsWithMultipleVersions: multiVersionGroups.length,
    multiVersionGroups,
  });
}
