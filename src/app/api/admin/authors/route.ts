// src/app/api/admin/authors/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { resolveOrCreateAuthor, AuthorNameError } from '@/lib/author';

export const dynamic = 'force-dynamic';

// GET /api/admin/authors?status=PENDING
//
// Admin review list for authors. Defaults to PENDING (the actionable
// queue); status=APPROVED browses the live list. `submissionCount` counts
// only live (non-soft-deleted) submissions, so it matches what the
// /submissions?author=... link it powers actually shows. `unlinkedCount`
// is unrelated to the requested tab — it's how many submissions still have
// only the legacy free-text author with no linked row at all, for the
// backfill banner (see /api/admin/authors/backfill).
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

  const [rows, pendingCount, usage, unlinkedCount] = await Promise.all([
    prisma.author.findMany({
      where: { status: status as any },
      select: { id: true, name: true, status: true, createdAt: true, submittedById: true },
      orderBy: status === 'PENDING' ? { createdAt: 'desc' as const } : { name: 'asc' as const },
      take: 500,
    }),
    prisma.author.count({ where: { status: 'PENDING' } }),
    // groupBy rather than a filtered relation _count — same choice (and
    // reasoning) as the matching query in the admin franchises route.
    prisma.submission.groupBy({
      by: ['authorId'],
      where: { authorId: { not: null }, deletedAt: null },
      _count: { _all: true },
    }),
    // Legacy submissions with a credited author string but no linked Author
    // row yet — same filter shape as /api/admin/authors/backfill's own
    // selection, so this number always matches what that route would
    // process. NOT: { author: '' } catches the ordinary empty-string case;
    // whitespace-only text is rare enough (and harmless enough — the
    // backfill route itself skips it safely) not to need a raw-SQL trim
    // here just for a display count.
    prisma.submission.count({
      where: { authorId: null, author: { not: null }, deletedAt: null, NOT: { author: '' } },
    }),
  ]);

  const usageById = new Map<string, number>();
  for (const u of usage) {
    if (u.authorId) usageById.set(u.authorId, u._count._all);
  }

  // submittedById is a plain column (no relation), so resolve names
  // separately — one query for the whole page rather than one per row.
  const submitterIds = Array.from(new Set(rows.map((r) => r.submittedById).filter((id): id is string => !!id)));
  const submitters = submitterIds.length
    ? await prisma.user.findMany({ where: { id: { in: submitterIds } }, select: { id: true, name: true } })
    : [];
  const submitterName = new Map(submitters.map((u) => [u.id, u.name]));

  const authors = rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    createdAt: r.createdAt,
    submittedByName: r.submittedById ? submitterName.get(r.submittedById) ?? null : null,
    submissionCount: usageById.get(r.id) ?? 0,
  }));

  return NextResponse.json({ authors, pendingCount, unlinkedCount });
}

const createSchema = z.object({ name: z.string().trim().min(1, 'Enter an author name').max(300) });

// POST /api/admin/authors  { name }
//
// An admin adding an author directly (e.g. seeding the initial list) —
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
    result = await resolveOrCreateAuthor(prisma, {
      name: parsed.data.name,
      submittedById: session.user.id,
      status: 'APPROVED',
      approvedById: session.user.id,
      approvedAt: new Date(),
    });
  } catch (err) {
    if (err instanceof AuthorNameError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  if (result.isNew || result.promoted) {
    await prisma.auditLog.create({
      data: {
        action: result.isNew ? 'AUTHOR_CREATED' : 'AUTHOR_APPROVED',
        details: { authorId: result.authorId, name: result.name },
        userId: session.user.id,
      },
    });
  }

  return NextResponse.json({ ...result, alreadyExisted: !result.isNew && !result.promoted });
}
