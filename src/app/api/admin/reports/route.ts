// src/app/api/admin/reports/route.ts
//
// Admin queue of "Report issue" reports. Same shape as the other review queues
// (e.g. /api/admin/alternate-formats): a status filter plus real-time counts for
// every tab, regardless of which tab was asked for. Reports on soft-deleted
// entries are left out of both the list and the counts — nothing to act on.
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isIssueType } from '@/lib/issueReports';

const STATUSES = ['OPEN', 'RESOLVED', 'DISMISSED'] as const;

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status') ?? 'OPEN';
  if (!(STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
  }
  const type = searchParams.get('type');
  if (type && !isIssueType(type)) {
    return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
  }

  const live = { submission: { deletedAt: null } };
  const [items, grouped, openByEntry] = await Promise.all([
    prisma.issueReport.findMany({
      where: { ...live, status: status as any, ...(type ? { type: type as any } : {}) },
      select: {
        id: true, submissionId: true, type: true, comment: true, status: true, createdAt: true,
        resolvedAt: true, resolutionNote: true, duplicateOfId: true,
        user: { select: { id: true, name: true, username: true } },
        resolvedBy: { select: { id: true, name: true, username: true } },
        original: { select: { id: true, hackName: true, version: true } },
        submission: { select: { hackName: true, version: true, platform: true } },
      },
      // Oldest open first so nothing sits forgotten at the bottom; closed ones newest first.
      orderBy: { createdAt: status === 'OPEN' ? 'asc' : 'desc' },
      take: 200,
    }),
    prisma.issueReport.groupBy({ by: ['status'], where: live, _count: { _all: true } }),
    prisma.issueReport.groupBy({ by: ['submissionId'], where: { ...live, status: 'OPEN' }, _count: { _all: true } }),
  ]);

  const counts = { OPEN: 0, RESOLVED: 0, DISMISSED: 0 } as Record<string, number>;
  for (const g of grouped) counts[g.status] = g._count._all;
  const openOnEntry: Record<string, number> = {};
  for (const g of openByEntry) openOnEntry[g.submissionId] = g._count._all;

  return NextResponse.json({
    items: items.map((i) => ({ ...i, openOnEntry: openOnEntry[i.submissionId] ?? 0 })),
    counts,
  });
}
