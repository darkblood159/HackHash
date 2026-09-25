// src/app/api/admin/franchises/[id]/merge/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';

const mergeSchema = z.object({ intoId: z.string().min(1, 'Pick a franchise to merge into') });

// POST /api/admin/franchises/[id]/merge  { intoId }
//
// The safety net for the duplicates the picker's own matching didn't catch
// ("Mario" and "Super Mario" both got created): moves EVERY submission off
// this franchise (the "from", identified by the URL) onto `intoId`, then
// deletes the now-empty from-row. Mirrors what /admin/hack-families'
// merge does for families. The target keeps its own name — if you want the
// merged result to be called something else, rename the target afterward.
//
// If the from-franchise was APPROVED and the target wasn't, the target is
// promoted to APPROVED: an admin deliberately choosing to fold a live
// franchise into it is a clear enough signal, and leaving the result
// PENDING would quietly hide a franchise that was public a moment ago.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const parsed = mergeSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message ?? 'Invalid request' }, { status: 400 });
  }
  const { intoId } = parsed.data;
  if (intoId === params.id) {
    return NextResponse.json({ error: "Can't merge a franchise into itself" }, { status: 400 });
  }

  const [from, into] = await Promise.all([
    prisma.franchise.findUnique({ where: { id: params.id } }),
    prisma.franchise.findUnique({ where: { id: intoId } }),
  ]);
  if (!from || !into) {
    return NextResponse.json({ error: 'One of those franchises no longer exists' }, { status: 404 });
  }

  const promoteTarget = from.status === 'APPROVED' && into.status !== 'APPROVED';

  const moved = await prisma.$transaction(async (tx) => {
    const result = await tx.submission.updateMany({ where: { franchiseId: from.id }, data: { franchiseId: into.id } });
    if (promoteTarget) {
      await tx.franchise.update({
        where: { id: into.id },
        data: { status: 'APPROVED', approvedById: session.user.id, approvedAt: new Date() },
      });
    }
    // Nothing references `from` anymore — the updateMany above already
    // moved every submission that did — so this can never hit the FK.
    await tx.franchise.delete({ where: { id: from.id } });
    await tx.auditLog.create({
      data: {
        action: 'FRANCHISE_MERGED',
        details: { fromId: from.id, fromName: from.name, intoId: into.id, intoName: into.name, movedSubmissions: result.count, promotedTarget: promoteTarget },
        userId: session.user.id,
      },
    });
    return result.count;
  });

  return NextResponse.json({ ok: true, moved, promotedTarget: promoteTarget });
}
