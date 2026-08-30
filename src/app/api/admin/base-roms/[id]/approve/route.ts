// src/app/api/admin/base-roms/[id]/approve/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';

const approveSchema = z.object({
  // Lets an admin clean up the submitter's free-text name on the way
  // through, same "the person reviewing can correct it" idea as everywhere
  // else in this project that accepts free text from a non-admin.
  name: z.string().min(1).max(300).optional(),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const baseRom = await prisma.baseRom.findUnique({ where: { id: params.id } });
  if (!baseRom) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const parsed = approveSchema.safeParse(await req.json().catch(() => ({})));
  const name = parsed.success && parsed.data.name ? parsed.data.name : baseRom.name;

  await prisma.baseRom.update({
    where: { id: params.id },
    data: { status: 'APPROVED', approvedById: session.user.id, approvedAt: new Date(), name, rejectionReason: null },
  });

  await prisma.auditLog.create({
    data: {
      action: 'BASE_ROM_APPROVED',
      details: { baseRomId: params.id, name },
      userId: session.user.id,
    },
  });

  return NextResponse.json({ ok: true });
}
