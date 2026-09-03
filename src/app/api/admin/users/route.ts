// src/app/api/admin/users/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { applyTrustEvent } from '@/lib/trust';
import { z } from 'zod';

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1'));
  const perPage = 25;
  const search = searchParams.get('q');

  const where = search
    ? {
        OR: [
          { name: { contains: search, mode: 'insensitive' as const } },
          { username: { contains: search, mode: 'insensitive' as const } },
          { email: { contains: search, mode: 'insensitive' as const } },
        ],
      }
    : {};

  const [total, users, commentCounts] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      select: {
        id: true, name: true, email: true, image: true, username: true,
        role: true, trustScore: true, isBanned: true, createdAt: true,
        _count: { select: { submissions: true, verifications: true } },
      },
      orderBy: { trustScore: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    // Filtered to isDeleted: false and merged in below — same reasoning as
    // admin/users/page.tsx's own identical query: an unfiltered relation
    // count would never drop after comments get deleted through either the
    // per-comment or mass-delete paths, which would make that number
    // actively misleading rather than just imprecise.
    prisma.comment.groupBy({ by: ['userId'], where: { isDeleted: false }, _count: { _all: true } }),
  ]);
  const commentCountByUser = new Map(commentCounts.map((c) => [c.userId, c._count._all]));
  const items = users.map((u) => ({ ...u, commentCount: commentCountByUser.get(u.id) ?? 0 }));

  return NextResponse.json({ items, total, page, perPage, totalPages: Math.ceil(total / perPage) });
}

const updateUserSchema = z.object({
  userId: z.string(),
  action: z.enum(['SET_ROLE', 'ADJUST_TRUST', 'BAN', 'UNBAN', 'DELETE_COMMENTS']),
  role: z.enum(['CONTRIBUTOR', 'VERIFIER', 'ADMINISTRATOR']).optional(),
  trustDelta: z.number().int().optional(),
  reason: z.string().max(500).optional(),
});

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json();
  const parsed = updateUserSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed' }, { status: 422 });
  }

  const { userId, action, role, trustDelta, reason } = parsed.data;

  if (userId === session.user.id && (action === 'BAN' || (action === 'SET_ROLE' && role !== 'ADMINISTRATOR'))) {
    return NextResponse.json({ error: "You can't ban or demote your own account" }, { status: 400 });
  }

  if (action === 'SET_ROLE' && role) {
    await prisma.user.update({ where: { id: userId }, data: { role } });
    await prisma.auditLog.create({
      data: {
        action: 'USER_ROLE_CHANGED',
        details: { targetUserId: userId, newRole: role, reason },
        userId: session.user.id,
      },
    });
    return NextResponse.json({ message: `Role updated to ${role}` });
  }

  if (action === 'ADJUST_TRUST' && trustDelta !== undefined) {
    await applyTrustEvent({
      userId,
      eventType: 'ADMIN_ADJUSTMENT',
      reason: reason ?? 'Admin trust adjustment',
      delta: trustDelta,
    });
    return NextResponse.json({ message: `Trust adjusted by ${trustDelta}` });
  }

  if (action === 'BAN') {
    await prisma.user.update({ where: { id: userId }, data: { isBanned: true } });
    // Database sessions mean we can actually invalidate their existing
    // login(s) immediately, instead of the ban only taking effect on their
    // next sign-in.
    await prisma.session.deleteMany({ where: { userId } });
    await prisma.auditLog.create({
      data: {
        action: 'USER_BANNED',
        details: { targetUserId: userId, reason },
        userId: session.user.id,
      },
    });
    return NextResponse.json({ message: 'User banned and signed out' });
  }

  if (action === 'UNBAN') {
    await prisma.user.update({ where: { id: userId }, data: { isBanned: false } });
    return NextResponse.json({ message: 'User unbanned' });
  }

  if (action === 'DELETE_COMMENTS') {
    const targetUser = await prisma.user.findUnique({ where: { id: userId }, select: { isBanned: true } });
    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    // Deliberately scoped to already-banned accounts, matching what was
    // actually asked for — bulk-clearing someone's entire comment history
    // is a heavier action than removing one comment at a time (which admins
    // can already do from any submission's discussion regardless of ban
    // status), so it's reserved for the same "this account is bad" call
    // banning already represents, rather than offered as a general-purpose
    // bulk tool usable on anyone. Enforced here, not just hidden in the UI.
    if (!targetUser.isBanned) {
      return NextResponse.json(
        { error: 'Only comments from banned users can be mass-deleted — ban the user first.' },
        { status: 400 }
      );
    }

    const { count } = await prisma.comment.updateMany({
      where: { userId, isDeleted: false },
      data: { isDeleted: true },
    });

    await prisma.auditLog.create({
      data: {
        action: 'USER_COMMENTS_DELETED',
        details: { targetUserId: userId, count },
        userId: session.user.id,
      },
    });

    return NextResponse.json({ message: `Deleted ${count} comment${count === 1 ? '' : 's'}`, count });
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}
