// src/app/api/admin/base-roms/[id]/edit/route.ts
//
// Lets an admin correct a BaseRom's own name or platform at any time,
// regardless of its current status — not just the one-time "fix a typo on
// the way through" the approve route already offered for PENDING rows.
// Deliberately separate from approve/reject: this never touches `status`,
// `approvedById`, `approvedAt`, or `rejectionReason` — those stay exactly
// as they were, changed only by the dedicated approve/reject actions.
//
// Deliberately does NOT accept crc32/md5/sha1. Those are the base rom's
// actual identity (sha1 specifically is globally @unique and is what
// resolveOrCreateBaseRom in src/lib/baseRom.ts dedupes new submissions
// against) — editing them would let one row quietly become a different
// physical file's identity. If a base rom's hashes are genuinely wrong,
// the right fix is rejecting it and using/creating the correct one, not
// mutating the hash identity of a row other submissions may already
// reference.
//
// Also deliberately does NOT touch any Submission that already links to
// this BaseRom — same "connect, don't force-overwrite" philosophy already
// used by the reject route above (a submission's own platform/name fields
// are untouched by an edit here; if a submission itself needs correcting,
// that's a separate submission-level edit via AdminEditPanel's own Base
// ROM picker).
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { PLATFORMS } from '@/types';

const editSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  platform: z.enum(PLATFORMS).optional(),
  // Same non-identity-metadata category as name/platform above (see this
  // file's own header comment on why crc32/md5/sha1 are deliberately NOT
  // here) — an admin correcting or backfilling what a submitter's file
  // extension actually was, same as they'd fix a typo'd name. An empty
  // string clears it back to null (submitted rows can be wrong; DAT-
  // imported rows never had one to begin with) rather than being rejected
  // as "too short," which is why this isn't `.min(1)` like name is.
  fileExtension: z.string().trim().max(10).optional(),
}).refine((data) => data.name !== undefined || data.platform !== undefined || data.fileExtension !== undefined, {
  message: 'Provide a name, platform, and/or file extension to update',
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const baseRom = await prisma.baseRom.findUnique({ where: { id: params.id } });
  if (!baseRom) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const parsed = editSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 });
  }

  // Built via conditional spread rather than a hand-declared `{ platform?:
  // string }`-shaped variable — that widened Zod's inferred platform type
  // (a literal union matching Prisma's own Platform enum, since PLATFORMS
  // is the single shared source for both) down to a bare `string`, which
  // Prisma's generated BaseRomUpdateInput correctly rejects. Spreading
  // straight from parsed.data keeps the precise literal type intact.
  const updated = await prisma.baseRom.update({
    where: { id: params.id },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.platform !== undefined ? { platform: parsed.data.platform } : {}),
      // Lowercased, leading dot stripped (forgives an admin typing ".z64"
      // instead of "z64" — same input either way should mean the same
      // thing), empty string clears it back to null.
      ...(parsed.data.fileExtension !== undefined
        ? { fileExtension: parsed.data.fileExtension.toLowerCase().replace(/^\./, '') || null }
        : {}),
    },
  });

  await prisma.auditLog.create({
    data: {
      action: 'BASE_ROM_EDITED',
      details: {
        baseRomId: params.id,
        before: { name: baseRom.name, platform: baseRom.platform, fileExtension: baseRom.fileExtension },
        after: { name: updated.name, platform: updated.platform, fileExtension: updated.fileExtension },
      },
      userId: session.user.id,
    },
  });

  return NextResponse.json({ ok: true, name: updated.name, platform: updated.platform, fileExtension: updated.fileExtension });
}
