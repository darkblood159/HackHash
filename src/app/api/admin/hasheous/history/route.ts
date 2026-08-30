// src/app/api/admin/hasheous/history/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const direction = searchParams.get('direction'); // 'PULL' | 'PUSH' | null (both)
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1'));
  const perPage = Math.min(50, Math.max(1, parseInt(searchParams.get('perPage') ?? '25')));

  const where: Record<string, unknown> = {};
  if (direction === 'PULL' || direction === 'PUSH') where.direction = direction;

  const [total, jobs] = await Promise.all([
    prisma.syncJob.count({ where }),
    prisma.syncJob.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  // Attach requester name for manual jobs (best-effort — a deleted user
  // shouldn't break this list)
  const userIds = Array.from(new Set(jobs.map((j) => j.userId).filter(Boolean))) as string[];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, username: true } })
    : [];
  const userMap = new Map(users.map((u) => [u.id, u]));

  return NextResponse.json({
    items: jobs.map((j) => ({ ...j, triggeredByUser: j.userId ? userMap.get(j.userId) ?? null : null })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  });
}
