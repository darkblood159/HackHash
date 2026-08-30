// src/app/api/admin/base-roms/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// GET /api/admin/base-roms?status=PENDING
//
// Admin review queue for base ROMs. Defaults to PENDING (the actionable
// list); pass status=APPROVED or status=REJECTED to browse those instead.
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status') ?? 'PENDING';
  if (!['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
  }

  const [baseRoms, pendingCount] = await Promise.all([
    prisma.baseRom.findMany({
      where: { status: status as any },
      select: {
        id: true, platform: true, name: true, crc32: true, md5: true, sha1: true, status: true,
        createdAt: true, rejectionReason: true,
        submittedBy: { select: { id: true, name: true } },
        _count: { select: { submissions: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.baseRom.count({ where: { status: 'PENDING' } }),
  ]);

  return NextResponse.json({ baseRoms, pendingCount });
}
