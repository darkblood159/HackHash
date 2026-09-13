// src/app/api/admin/alternate-formats/route.ts
//
// Admin review queue for alternate-format entries — same shape as GET
// /api/admin/base-roms (status param defaults to PENDING, always returns a
// real-time pendingCount alongside the filtered list regardless of which
// status was requested, so the frontend can show a tab count). This is the
// "admin menu" surface that was missing entirely before: an alt-format
// entry previously only became visible by happening to open the specific
// submission it was added to — nothing surfaced it site-wide. Admin-only,
// matching this route's own namespace convention (see section 9 of the
// handoff) — Verifiers/Veteran-tier reviewers can still review from a
// submission's own page, just without this dedicated queue view.
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
  if (!['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
  }

  const [items, pendingCount] = await Promise.all([
    prisma.alternateFormat.findMany({
      where: { status: status as any, submission: { deletedAt: null } },
      select: {
        id: true, submissionId: true, format: true, filename: true, fileSize: true,
        crc32: true, md5: true, sha1: true, status: true, rejectionReason: true, createdAt: true,
        verifiedByHash: true,
        addedBy: { select: { id: true, name: true, username: true } },
        reviewedBy: { select: { id: true, name: true, username: true } },
        submission: { select: { hackName: true, version: true, platform: true } },
      },
      orderBy: { createdAt: 'asc' }, // oldest-pending-first, so nothing sits forgotten at the bottom
      take: 200,
    }),
    prisma.alternateFormat.count({ where: { status: 'PENDING', submission: { deletedAt: null } } }),
  ]);

  return NextResponse.json({
    items: items.map((i) => ({ ...i, fileSize: i.fileSize.toString() })),
    pendingCount,
  });
}
