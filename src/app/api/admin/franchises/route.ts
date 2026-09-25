// src/app/api/admin/franchises/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { resolveOrCreateFranchise, FranchiseNameError } from '@/lib/franchise';

export const dynamic = 'force-dynamic';

// GET /api/admin/franchises?status=PENDING
//
// Admin review list for franchises. Defaults to PENDING (the actionable
// queue); status=APPROVED browses the live list. `submissionCount` counts
// only live (non-soft-deleted) submissions, so it matches what the
// /submissions?franchise=... link it powers actually shows.
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status') ?? 'PENDING';
  if (!['PENDING', 'APPROVED'].includes(status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
  }

  const [rows, pendingCount, usage] = await Promise.all([
    prisma.franchise.findMany({
      where: { status: status as any },
      select: { id: true, name: true, status: true, createdAt: true, submittedById: true },
      orderBy: status === 'PENDING' ? { createdAt: 'desc' as const } : { name: 'asc' as const },
      take: 500,
    }),
    prisma.franchise.count({ where: { status: 'PENDING' } }),
    // groupBy rather than a filtered relation _count — same choice (and
    // reasoning) as the comment-count query in src/app/admin/users/page.tsx.
    prisma.submission.groupBy({
      by: ['franchiseId'],
      where: { franchiseId: { not: null }, deletedAt: null },
      _count: { _all: true },
    }),
  ]);

  const usageById = new Map<string, number>();
  for (const u of usage) {
    if (u.franchiseId) usageById.set(u.franchiseId, u._count._all);
  }

  // submittedById is a plain column (no relation), so resolve names
  // separately — one query for the whole page rather than one per row.
  const submitterIds = Array.from(new Set(rows.map((r) => r.submittedById).filter((id): id is string => !!id)));
  const submitters = submitterIds.length
    ? await prisma.user.findMany({ where: { id: { in: submitterIds } }, select: { id: true, name: true } })
    : [];
  const submitterName = new Map(submitters.map((u) => [u.id, u.name]));

  const franchises = rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    createdAt: r.createdAt,
    submittedByName: r.submittedById ? submitterName.get(r.submittedById) ?? null : null,
    submissionCount: usageById.get(r.id) ?? 0,
  }));

  return NextResponse.json({ franchises, pendingCount });
}

const createSchema = z.object({ name: z.string().trim().min(1, 'Enter a franchise name').max(300) });

// POST /api/admin/franchises  { name }
//
// An admin adding a franchise directly (e.g. seeding the initial list) —
// created already APPROVED. If it already exists as PENDING it's promoted
// to APPROVED instead; if it already exists approved, nothing changes and
// `alreadyExisted` says so.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message ?? 'Invalid request' }, { status: 400 });
  }

  let result;
  try {
    result = await resolveOrCreateFranchise(prisma, {
      name: parsed.data.name,
      submittedById: session.user.id,
      status: 'APPROVED',
      approvedById: session.user.id,
      approvedAt: new Date(),
    });
  } catch (err) {
    if (err instanceof FranchiseNameError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  if (result.isNew || result.promoted) {
    await prisma.auditLog.create({
      data: {
        action: result.isNew ? 'FRANCHISE_CREATED' : 'FRANCHISE_APPROVED',
        details: { franchiseId: result.franchiseId, name: result.name },
        userId: session.user.id,
      },
    });
  }

  return NextResponse.json({ ...result, alreadyExisted: !result.isNew && !result.promoted });
}
