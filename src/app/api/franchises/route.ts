// src/app/api/franchises/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { normalizeNameKey } from '@/lib/hackFamily';
import {
  searchFranchises,
  resolveOrCreateFranchise,
  cleanFranchiseName,
  FranchiseNameError,
  MAX_PENDING_FRANCHISES_PER_USER,
} from '@/lib/franchise';

// Never cache — the picker needs to see a franchise someone else created a
// moment ago, which is the whole point of showing pending ones at all.
export const dynamic = 'force-dynamic';

// GET /api/franchises?q=optional-search&includePending=1
//
// Powers the franchise picker (submit form, admin edit panel, propose-a-
// change form). Public, no auth — same visibility tier as GET /api/base-roms
// and the rest of the browse-facing data; only ever returns names.
//
// By default returns APPROVED franchises only. The picker passes
// includePending=1 so it ALSO surfaces franchises someone else has
// proposed but an admin hasn't reviewed yet — deliberately different from
// base roms, which hide pending rows from the list. A base rom is found
// again by hashing the same file, so hiding pending ones costs nothing
// there; a franchise has no such second route back to an existing row, so
// hiding a pending "Zelda" from the next person is exactly how you'd get a
// second "The Legend of Zelda" proposed alongside it.
//
// Response: { franchises: [{ id, name, status, exact, similar }], exactMatch }
// — `exact` = the query normalizes to precisely this franchise's name;
// `similar` = a near-miss by edit distance rather than a substring match.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q')?.trim() || undefined;
  const includePending = searchParams.get('includePending') === '1';
  const excludeId = searchParams.get('excludeId') || undefined;

  const { hits, exactMatch } = await searchFranchises(prisma, q, {
    includePending,
    limit: q ? 15 : 50,
    excludeId,
  });

  return NextResponse.json({ franchises: hits, exactMatch });
}

const createFranchiseSchema = z.object({
  name: z.string().trim().min(1, 'Enter a franchise name').max(300),
});

// POST /api/franchises  { name }
//
// A submitter proposing a franchise that wasn't in the list. Resolve-or-
// create: if a franchise with the same normalized name already exists
// (approved OR still pending from someone else) this transparently returns
// THAT one instead of creating a duplicate — see resolveOrCreateFranchise.
// A genuinely new name is created PENDING for an admin to review; the
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

  const parsed = createFranchiseSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message ?? 'Invalid request' }, { status: 400 });
  }

  const isAdmin = session.user.role === 'ADMINISTRATOR';
  const name = cleanFranchiseName(parsed.data.name);
  const nameKey = normalizeNameKey(name);
  if (!nameKey) {
    return NextResponse.json({ error: 'A franchise name needs at least one letter or number.' }, { status: 400 });
  }

  // The pending cap only matters when this would create a NEW row —
  // picking a franchise that already exists must never be blocked by it.
  if (!isAdmin) {
    const existing = await prisma.franchise.findUnique({ where: { nameKey }, select: { id: true } });
    if (!existing) {
      const open = await prisma.franchise.count({ where: { submittedById: session.user.id, status: 'PENDING' } });
      if (open >= MAX_PENDING_FRANCHISES_PER_USER) {
        return NextResponse.json(
          { error: `You already have ${open} franchises waiting for review — please wait for those to be approved before proposing more.` },
          { status: 429 }
        );
      }
    }
  }

  let result;
  try {
    result = await resolveOrCreateFranchise(prisma, {
      name,
      submittedById: session.user.id,
      ...(isAdmin ? { status: 'APPROVED' as const, approvedById: session.user.id, approvedAt: new Date() } : {}),
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
        action: result.isNew ? (isAdmin ? 'FRANCHISE_CREATED' : 'FRANCHISE_SUBMITTED') : 'FRANCHISE_APPROVED',
        details: { franchiseId: result.franchiseId, name: result.name },
        userId: session.user.id,
      },
    });
  }

  return NextResponse.json(result);
}
