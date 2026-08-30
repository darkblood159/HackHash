// src/app/api/admin/base-roms/[id]/remove/route.ts
//
// A genuine hard delete — deliberately NOT a soft-delete, unlike Submission
// elsewhere in this project. Reasoning, since that's a real departure from
// this app's usual "never hard-delete history" default:
//
// 1. BaseRom.sha1 is globally @unique. A soft-delete would leave that hash
//    permanently occupying the unique slot, meaning re-hashing the exact
//    same physical file later could never create a fresh row for it (a
//    P2002 unique-constraint conflict) without also building "revive a
//    soft-deleted row" logic into resolveOrCreateBaseRom — real added
//    complexity for what should be a simple admin convenience. A hard
//    delete frees the sha1 cleanly; if the same file resurfaces, it just
//    goes through the normal, already-existing "not found, create new"
//    path with no special-casing needed.
// 2. Unlike a Submission (real community contribution + verification
//    history), an unreferenced BaseRom row — the ONLY case this endpoint
//    allows removing — has much lower loss-on-mistake stakes: at worst,
//    re-hashing/re-approving the same file again later.
// 3. There's already a precedent for exactly this shape in this codebase:
//    POST /api/admin/hack-families/merge hard-deletes the now-empty
//    "from" family once nothing references it anymore. This mirrors that.
//
// BLOCKED, not cascaded, when anything still references it — Submission.
// baseRomId has no onDelete configured (Prisma/Postgres default, checked
// directly against schema.prisma rather than assumed), so an unguarded
// delete would surface as a raw FK violation (P2003) if any submission —
// including a soft-deleted one, which still holds the FK — points at it.
// Counting ALL submissions regardless of their own status/deletedAt
// mirrors exactly what the database constraint itself would enforce.
// If blocked, the fix is reassigning those submissions to a different
// base rom first (AdminEditPanel's BaseRomPicker), same as HackFamily
// reassignment already works before a family can end up empty.
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const baseRom = await prisma.baseRom.findUnique({ where: { id: params.id } });
  if (!baseRom) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const referencingCount = await prisma.submission.count({ where: { baseRomId: params.id } });
  if (referencingCount > 0) {
    return NextResponse.json(
      {
        error: `Can't remove — ${referencingCount} submission${referencingCount === 1 ? '' : 's'} still reference${referencingCount === 1 ? 's' : ''} this base ROM. Reassign ${referencingCount === 1 ? 'it' : 'them'} to a different one first, from each submission's edit panel.`,
        referencingCount,
      },
      { status: 409 }
    );
  }

  // Audit log written BEFORE the delete so the row's own identity (name,
  // platform, hashes) is captured while it still exists — AuditLog.details
  // is a plain Json field, not a real FK to BaseRom, so this survives the
  // row being gone with no orphan/cascade concern of its own.
  await prisma.auditLog.create({
    data: {
      action: 'BASE_ROM_REMOVED',
      details: { baseRomId: params.id, name: baseRom.name, platform: baseRom.platform, sha1: baseRom.sha1, status: baseRom.status },
      userId: session.user.id,
    },
  });

  await prisma.baseRom.delete({ where: { id: params.id } });

  return NextResponse.json({ ok: true });
}
