// src/app/api/notifications/route.ts
//
// GET: the signed-in user's own notifications, newest first, plus how many are
// unread. Only ever returns the caller's own rows.
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const raw = req.nextUrl.searchParams.get('limit');
  const parsed = raw && /^\d{1,3}$/.test(raw) ? parseInt(raw, 10) : DEFAULT_LIMIT;
  const limit = Math.min(Math.max(parsed, 1), MAX_LIMIT);

  try {
    const [items, unread] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: session.user.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: limit,
        select: { id: true, type: true, title: true, body: true, href: true, readAt: true, createdAt: true },
      }),
      prisma.notification.count({ where: { userId: session.user.id, readAt: null } }),
    ]);
    return NextResponse.json({ items, unread });
  } catch (err) {
    console.error('List notifications failed:', err);
    return NextResponse.json({ error: 'Could not load notifications' }, { status: 500 });
  }
}
