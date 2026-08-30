// src/app/api/admin/hack-families/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { findDuplicateFamilyCandidates } from '@/lib/hackFamily';

// GET /api/admin/hack-families
//
// Powers the admin hack-families page: overall counts plus the list of
// same-platform family pairs whose names look like they're actually the
// same hack (see findDuplicateFamilyCandidates in src/lib/hackFamily.ts —
// same matching rules used for the "did you mean" prompt on new
// submissions). Read-only; merging happens via POST .../merge.
export async function GET(_req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const [totalFamilies, ungroupedSubmissions, families, duplicateCandidates] = await Promise.all([
    prisma.hackFamily.count(),
    prisma.submission.count({ where: { hackFamilyId: null } }),
    prisma.hackFamily.findMany({ select: { _count: { select: { submissions: true } } } }),
    findDuplicateFamilyCandidates(prisma),
  ]);

  const multiVersionFamilies = families.filter((f) => f._count.submissions > 1).length;
  const totalGroupedSubmissions = families.reduce((sum, f) => sum + f._count.submissions, 0);

  return NextResponse.json({
    totalFamilies,
    multiVersionFamilies,
    totalGroupedSubmissions,
    ungroupedSubmissions,
    duplicateCandidates,
  });
}
