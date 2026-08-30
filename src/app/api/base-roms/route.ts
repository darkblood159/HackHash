// src/app/api/base-roms/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { PLATFORMS } from '@/types';
import { resolveOrCreateBaseRom } from '@/lib/baseRom';

// GET /api/base-roms?platform=X&q=optional-search
//
// Approved base ROMs for a platform — powers the "select an existing base
// ROM" picker on the submit form. Public, no auth (same visibility tier as
// the rest of the browse-facing data) — only ever returns APPROVED rows;
// PENDING/REJECTED ones aren't meant to be selectable, only reachable by
// hashing a matching file (see POST below, which transparently links to a
// pending one if the hash matches rather than creating a duplicate).
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const platformParam = searchParams.get('platform');
  const q = searchParams.get('q')?.trim();

  if (!platformParam || !(PLATFORMS as readonly string[]).includes(platformParam)) {
    return NextResponse.json({ error: 'A valid platform is required' }, { status: 400 });
  }

  const baseRoms = await prisma.baseRom.findMany({
    where: {
      platform: platformParam as any,
      status: 'APPROVED',
      ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
    },
    select: { id: true, name: true, crc32: true, md5: true, sha1: true },
    orderBy: { name: 'asc' },
    take: 100,
  });

  return NextResponse.json({ baseRoms });
}

const submitBaseRomSchema = z.object({
  platform: z.enum(PLATFORMS),
  // Optional here specifically so the client can hash a file and check for
  // an existing match FIRST — no point asking "what's this called?" if the
  // hash already resolves to something. Required only when it turns out to
  // be genuinely new (checked below, before resolveOrCreateBaseRom runs).
  name: z.string().min(1).max(300).optional(),
  crc32: z.string().regex(/^[0-9a-f]{8}$/i, 'CRC32 must be 8 hex characters'),
  md5: z.string().regex(/^[0-9a-f]{32}$/i, 'MD5 must be 32 hex characters'),
  sha1: z.string().regex(/^[0-9a-f]{40}$/i, 'SHA-1 must be 40 hex characters'),
});

// POST /api/base-roms
//
// A submitter hashed their own base rom (client-side, same single-pass
// approach as the hack ROM itself — the file never leaves the browser) and
// is proposing it. If a BaseRom with this exact SHA-1 already exists
// (APPROVED or still PENDING from someone else), transparently links to
// that instead of creating a duplicate — resolveOrCreateBaseRom handles
// this. A brand new hash creates a PENDING row for an admin to review; the
// submitter's own hack submission can still reference it immediately
// (doesn't have to wait for that review to complete).
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }
  if (session.user.isBanned) {
    return NextResponse.json({ error: 'Account suspended' }, { status: 403 });
  }

  const parsed = submitBaseRomSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message ?? 'Invalid request' }, { status: 400 });
  }

  const sha1 = parsed.data.sha1.toLowerCase();
  const existing = await prisma.baseRom.findUnique({ where: { sha1 } });
  if (!existing && !parsed.data.name) {
    // Genuinely new hash and no name given yet — tell the client to ask
    // for one and retry, rather than requiring it up front for what might
    // turn out to be an already-known base rom.
    return NextResponse.json({ error: 'nameRequired', nameRequired: true }, { status: 422 });
  }

  const result = await resolveOrCreateBaseRom(prisma, {
    ...parsed.data,
    name: parsed.data.name ?? '',
    submittedById: session.user.id,
  });

  if (result.isNew) {
    await prisma.auditLog.create({
      data: {
        action: 'BASE_ROM_SUBMITTED',
        details: { baseRomId: result.baseRomId, name: result.name, platform: parsed.data.platform },
        userId: session.user.id,
      },
    });
  }

  return NextResponse.json(result);
}
