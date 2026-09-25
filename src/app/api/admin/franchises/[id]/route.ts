// src/app/api/admin/franchises/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { normalizeNameKey } from '@/lib/hackFamily';
import { cleanFranchiseName, FRANCHISE_NAME_MAX } from '@/lib/franchise';

const patchSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter a franchise name').max(300).optional(),
    approve: z.boolean().optional(),
  })
  .refine((d) => d.name !== undefined || d.approve === true, { message: 'Nothing to change' });

// PATCH /api/admin/franchises/[id]  { name?, approve? }
//
// Rename and/or approve. Renaming recomputes the dedupe key too, and is
// refused (409) if the new name would collide with a DIFFERENT existing
// franchise — the right move there is merging the two, not renaming one
// into the other's identity (see the merge route next door).
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const franchise = await prisma.franchise.findUnique({ where: { id: params.id } });
  if (!franchise) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message ?? 'Invalid request' }, { status: 400 });
  }

  const data: { name?: string; nameKey?: string; status?: 'APPROVED'; approvedById?: string; approvedAt?: Date } = {};

  if (parsed.data.name !== undefined) {
    const name = cleanFranchiseName(parsed.data.name);
    const nameKey = normalizeNameKey(name);
    if (!nameKey) {
      return NextResponse.json({ error: 'A franchise name needs at least one letter or number.' }, { status: 400 });
    }
    if (name.length > FRANCHISE_NAME_MAX) {
      return NextResponse.json({ error: `Franchise names can be at most ${FRANCHISE_NAME_MAX} characters.` }, { status: 400 });
    }
    const clash = await prisma.franchise.findUnique({ where: { nameKey }, select: { id: true, name: true } });
    if (clash && clash.id !== franchise.id) {
      return NextResponse.json(
        { error: `A franchise called "${clash.name}" already exists — merge this one into it instead of renaming.`, existingId: clash.id },
        { status: 409 }
      );
    }
    data.name = name;
    data.nameKey = nameKey;
  }

  const approving = parsed.data.approve === true && franchise.status !== 'APPROVED';
  if (approving) {
    data.status = 'APPROVED';
    data.approvedById = session.user.id;
    data.approvedAt = new Date();
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ ok: true, unchanged: true });
  }

  try {
    await prisma.franchise.update({ where: { id: params.id }, data });
  } catch (err: any) {
    // Lost a race with someone creating/renaming to the same key between
    // the clash check above and this write.
    if (err?.code === 'P2002') {
      return NextResponse.json({ error: 'A franchise with that name already exists — merge instead of renaming.' }, { status: 409 });
    }
    throw err;
  }

  if (data.name !== undefined && data.name !== franchise.name) {
    await prisma.auditLog.create({
      data: {
        action: 'FRANCHISE_RENAMED',
        details: { franchiseId: params.id, from: franchise.name, to: data.name },
        userId: session.user.id,
      },
    });
  }
  if (approving) {
    await prisma.auditLog.create({
      data: {
        action: 'FRANCHISE_APPROVED',
        details: { franchiseId: params.id, name: data.name ?? franchise.name },
        userId: session.user.id,
      },
    });
  }

  return NextResponse.json({ ok: true });
}

// DELETE /api/admin/franchises/[id]
//
// A real delete, not a soft one — the same deliberate departure from the
// project's usual soft-delete default that base-rom removal makes (see
// CLAUDE_HANDOFF.txt section 2v), for the same reason: nameKey is globally
// unique, so a soft-deleted row would keep occupying that name forever and
// block anyone from ever re-creating it. Unlike a base rom, though, this is
// NOT blocked when submissions still use it: franchise is optional on a
// submission, so the database's ON DELETE SET NULL simply unlinks them
// (they stay fully intact, just franchise-less). The audit entry records
// how many were unlinked so it's clear afterward what a removal touched.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const franchise = await prisma.franchise.findUnique({ where: { id: params.id } });
  if (!franchise) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const unlinkedSubmissions = await prisma.submission.count({ where: { franchiseId: params.id } });

  // Audit first: AuditLog.details is plain Json with no FK to Franchise, so
  // the entry survives the row being gone with no orphan concern — same
  // ordering base-rom removal uses.
  await prisma.auditLog.create({
    data: {
      action: 'FRANCHISE_REMOVED',
      details: { franchiseId: params.id, name: franchise.name, status: franchise.status, unlinkedSubmissions },
      userId: session.user.id,
    },
  });

  await prisma.franchise.delete({ where: { id: params.id } });

  return NextResponse.json({ ok: true, unlinkedSubmissions });
}
