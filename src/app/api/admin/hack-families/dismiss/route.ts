// src/app/api/admin/hack-families/dismiss/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { dismissDuplicatePair } from '@/lib/hackFamily';

const dismissSchema = z.object({
  familyAId: z.string(),
  familyBId: z.string(),
});

// POST /api/admin/hack-families/dismiss
//
// Marks a pair the duplicate finder flagged as confirmed NOT the same hack
// — used from the "Not a duplicate" button on /admin/hack-families. Doesn't
// touch either family or any submission; purely suppresses this specific
// pair from future findDuplicateFamilyCandidates() results.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const parsed = dismissSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const { familyAId, familyBId } = parsed.data;
  if (familyAId === familyBId) {
    return NextResponse.json({ error: 'Not a valid pair' }, { status: 400 });
  }

  const [a, b] = await Promise.all([
    prisma.hackFamily.findUnique({ where: { id: familyAId } }),
    prisma.hackFamily.findUnique({ where: { id: familyBId } }),
  ]);
  if (!a || !b) {
    return NextResponse.json({ error: 'One of those families no longer exists' }, { status: 404 });
  }

  await dismissDuplicatePair(prisma, familyAId, familyBId, session.user.id);

  return NextResponse.json({ ok: true });
}
