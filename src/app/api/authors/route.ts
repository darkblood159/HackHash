// src/app/api/authors/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import {
  searchAuthors,
  resolveOrCreateAuthor,
  cleanAuthorName,
  authorNameKey,
  AuthorNameError,
  MAX_PENDING_AUTHORS_PER_USER,
} from '@/lib/author';

// Never cache — the picker needs to see an author someone else created a
// moment ago, which is the whole point of showing pending ones at all.
export const dynamic = 'force-dynamic';

// GET /api/authors?q=optional-search&includePending=1
//
// Powers the author picker (submit form, admin edit panel, propose-a-change
// form). Public, no auth — same visibility tier as GET /api/franchises;
// only ever returns names.
//
// By default returns APPROVED authors only. The picker passes
// includePending=1 so it ALSO surfaces authors someone else has proposed
// but an admin hasn't reviewed yet — same reasoning GET /api/franchises
// documents: an author has no second route back to an existing row the way
// a base rom does (found again by hashing the same file), so hiding a
// pending one from the next person is exactly how you'd get a second row
// proposed for the same person.
//
// Response: { authors: [{ id, name, status, exact, similar }], exactMatch }
// — `exact` = the query normalizes to precisely this author's name;
// `similar` = a near-miss by edit distance rather than a substring match.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q')?.trim() || undefined;
  const includePending = searchParams.get('includePending') === '1';
  const excludeId = searchParams.get('excludeId') || undefined;

  const { hits, exactMatch } = await searchAuthors(prisma, q, {
    includePending,
    limit: q ? 15 : 50,
    excludeId,
  });

  return NextResponse.json({ authors: hits, exactMatch });
}

const createAuthorSchema = z.object({
  name: z.string().trim().min(1, 'Enter an author name').max(300),
});

// POST /api/authors  { name }
//
// A submitter proposing an author who wasn't in the list. Resolve-or-
// create: if an author with the same normalized name already exists
// (approved OR still pending from someone else) this transparently returns
// THAT one instead of creating a duplicate — see resolveOrCreateAuthor. A
// genuinely new name is created PENDING for an admin to review; the
// submitter's own hack can reference it immediately without waiting.
// Admins are the exception: their own creation is the approval, so it's
// created (or an existing pending one promoted) as APPROVED straight away.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }
  if (session.user.isBanned) {
    return NextResponse.json({ error: 'Account suspended' }, { status: 403 });
  }

  const parsed = createAuthorSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message ?? 'Invalid request' }, { status: 400 });
  }

  const isAdmin = session.user.role === 'ADMINISTRATOR';
  const name = cleanAuthorName(parsed.data.name);
  const nameKey = authorNameKey(name);
  if (!nameKey) {
    return NextResponse.json({ error: 'An author name needs at least one letter or number.' }, { status: 400 });
  }

  // The pending cap only matters when this would create a NEW row —
  // picking an author that already exists must never be blocked by it.
  if (!isAdmin) {
    const existing = await prisma.author.findUnique({ where: { nameKey }, select: { id: true } });
    if (!existing) {
      const open = await prisma.author.count({ where: { submittedById: session.user.id, status: 'PENDING' } });
      if (open >= MAX_PENDING_AUTHORS_PER_USER) {
        return NextResponse.json(
          { error: `You already have ${open} authors waiting for review — please wait for those to be approved before proposing more.` },
          { status: 429 }
        );
      }
    }
  }

  let result;
  try {
    result = await resolveOrCreateAuthor(prisma, {
      name,
      submittedById: session.user.id,
      ...(isAdmin ? { status: 'APPROVED' as const, approvedById: session.user.id, approvedAt: new Date() } : {}),
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
        action: result.isNew ? (isAdmin ? 'AUTHOR_CREATED' : 'AUTHOR_SUBMITTED') : 'AUTHOR_APPROVED',
        details: { authorId: result.authorId, name: result.name },
        userId: session.user.id,
      },
    });
  }

  return NextResponse.json(result);
}
