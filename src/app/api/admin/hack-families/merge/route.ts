// src/app/api/admin/hack-families/merge/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';

const mergeSchema = z.object({
  fromFamilyId: z.string(),
  intoFamilyId: z.string(),
});

// POST /api/admin/hack-families/merge
//
// Moves every submission out of `fromFamilyId` and into `intoFamilyId`, then
// deletes the now-empty `fromFamilyId` row. Used from the admin hack-families
// page to fix cases the automatic matching missed or got wrong (see
// findDuplicateFamilyCandidates in src/lib/hackFamily.ts) — e.g. two
// families that turned out to be the same hack under slightly different
// names.
//
// Deliberately does NOT touch any submission's own hackName/author/
// releaseYear/releaseDate/description/tags, or intoFamilyId's own canonical fields —
// merging only reconnects them. If the merged versions should actually
// match going forward, edit any one of them afterward with "apply to all
// versions" checked, same as any other shared-field edit.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const parsed = mergeSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const { fromFamilyId, intoFamilyId } = parsed.data;

  if (fromFamilyId === intoFamilyId) {
    return NextResponse.json({ error: 'Cannot merge a family into itself' }, { status: 400 });
  }

  const [fromFamily, intoFamily] = await Promise.all([
    prisma.hackFamily.findUnique({ where: { id: fromFamilyId } }),
    prisma.hackFamily.findUnique({ where: { id: intoFamilyId } }),
  ]);
  if (!fromFamily || !intoFamily) {
    return NextResponse.json({ error: 'One of those families no longer exists' }, { status: 404 });
  }
  if (fromFamily.platform !== intoFamily.platform) {
    return NextResponse.json({ error: 'Those two families are on different platforms — merging would mix platforms on one hack' }, { status: 400 });
  }

  const movedCount = await prisma.$transaction(async (tx) => {
    const { count } = await tx.submission.updateMany({
      where: { hackFamilyId: fromFamilyId },
      data: { hackFamilyId: intoFamilyId },
    });
    await tx.hackFamily.delete({ where: { id: fromFamilyId } });
    await tx.auditLog.create({
      data: {
        action: 'HACK_FAMILIES_MERGED',
        details: { fromFamilyId, fromName: fromFamily.name, intoFamilyId, intoName: intoFamily.name, submissionsMoved: count },
        userId: session.user.id,
      },
    });
    return count;
  });

  return NextResponse.json({ movedCount, intoFamilyName: intoFamily.name });
}
