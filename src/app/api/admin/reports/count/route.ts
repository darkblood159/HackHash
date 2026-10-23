// src/app/api/admin/reports/count/route.ts
//
// Just the number of OPEN issue reports, for the little badge on the navbar's
// Admin link (every page, not only /admin). Admin-only; cheap (one indexed count).
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const open = await prisma.issueReport
    .count({ where: { status: 'OPEN', submission: { deletedAt: null } } })
    .catch(() => 0); // a badge must never throw (e.g. migration not applied yet)
  return NextResponse.json({ open });
}
