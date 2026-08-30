// src/app/api/admin/submissions/route.ts
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
  const status = searchParams.get('status') ?? 'PENDING';
  const platform = searchParams.get('platform');
  const deletedOnly = searchParams.get('deleted') === 'true';
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1'));
  const perPage = 25;

  // Normal moderation queue never shows soft-deleted items; the dedicated
  // "Deleted" tab shows ONLY soft-deleted items (any status), so admins can
  // review/restore them without them cluttering ordinary review work.
  const where: Record<string, unknown> = deletedOnly
    ? { deletedAt: { not: null } }
    : { status, deletedAt: null };
  if (platform) where.platform = platform;

  const [total, submissions] = await Promise.all([
    prisma.submission.count({ where: where as any }),
    prisma.submission.findMany({
      where: where as any,
      include: {
        submittedBy: { select: { id: true, name: true, image: true, username: true, trustScore: true } },
        tags: { include: { tag: true } },
        _count: { select: { verifications: true, comments: true } },
      },
      orderBy: deletedOnly ? [{ createdAt: 'desc' }] : [{ verificationScore: 'desc' }, { createdAt: 'asc' }],
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  return NextResponse.json({
    items: submissions.map((s) => ({ ...s, fileSize: s.fileSize.toString() })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  });
}
