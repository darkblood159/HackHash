// src/app/api/admin/hasheous/push-verification/route.ts
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const [pending, confirmed, notReflected, notReflectedItems] = await Promise.all([
    prisma.gameMapping.count({ where: { hasheousPushStatus: 'pending' } }),
    prisma.gameMapping.count({ where: { hasheousPushStatus: 'confirmed' } }),
    prisma.gameMapping.count({ where: { hasheousPushStatus: 'not_reflected' } }),
    prisma.gameMapping.findMany({
      where: { hasheousPushStatus: 'not_reflected' },
      select: {
        id: true, hasheousPushedAt: true,
        submissions: { select: { id: true, hackName: true }, take: 1 },
      },
      orderBy: { hasheousPushedAt: 'desc' },
      take: 20,
    }),
  ]);

  return NextResponse.json({
    pending,
    confirmed,
    notReflected,
    notReflectedItems: notReflectedItems.map((m) => ({
      gameMappingId: m.id,
      pushedAt: m.hasheousPushedAt,
      submissionId: m.submissions[0]?.id ?? null,
      hackName: m.submissions[0]?.hackName ?? '(unknown)',
    })),
  });
}
