// src/app/api/notifications/count/route.ts
//
// Just the unread number, for the bell in the navbar (every page). Cheap: one
// indexed count. Signed-out visitors get 0 rather than an error, and any failure
// (e.g. the migration has not been applied yet) also yields 0 - a badge must
// never throw.
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { unreadCount } from '@/lib/notifications';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ unread: 0 });
  return NextResponse.json({ unread: await unreadCount(session.user.id) });
}
