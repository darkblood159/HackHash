// src/app/api/notifications/read/route.ts
//
// POST: mark the caller's own notifications as read.
//   { ids: ["..."] }  - just those (max 100)
//   { all: true }     - every unread one
// Rows that belong to someone else, or do not exist, are silently left alone
// (they simply do not match the where clause).
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const bodySchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(100) }),
]);

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 422 });
  }

  try {
    const { count } = await prisma.notification.updateMany({
      where: {
        userId: session.user.id,
        readAt: null,
        ...('ids' in parsed.data ? { id: { in: parsed.data.ids } } : {}),
      },
      data: { readAt: new Date() },
    });
    return NextResponse.json({ updated: count });
  } catch (err) {
    console.error('Mark notifications read failed:', err);
    return NextResponse.json({ error: 'Could not update notifications' }, { status: 500 });
  }
}
