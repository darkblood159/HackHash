// src/app/api/admin/base-roms/[id]/reject/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';

const rejectSchema = z.object({
  reason: z.string().max(500).optional(),
});

// POST /api/admin/base-roms/[id]/reject
//
// Deliberately does NOT delete the row or touch any Submission that
// already links to it — a submission referencing a since-rejected base rom
// stays exactly as it was; rejecting only stops it from being FUTURE-
// selectable (not in the approved list) and flags it for review. If a
// submission's base rom turns out to be wrong, that's a submission-level
// edit (change its baseRomId), not something this endpoint does.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const baseRom = await prisma.baseRom.findUnique({ where: { id: params.id } });
  if (!baseRom) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const parsed = rejectSchema.safeParse(await req.json().catch(() => ({})));
  const reason = parsed.success ? parsed.data.reason : undefined;

  await prisma.baseRom.update({
    where: { id: params.id },
    data: { status: 'REJECTED', approvedById: session.user.id, approvedAt: new Date(), rejectionReason: reason ?? null },
  });

  await prisma.auditLog.create({
    data: {
      action: 'BASE_ROM_REJECTED',
      details: { baseRomId: params.id, name: baseRom.name, reason },
      userId: session.user.id,
    },
  });

  return NextResponse.json({ ok: true });
}
