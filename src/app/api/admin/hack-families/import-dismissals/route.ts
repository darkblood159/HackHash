// src/app/api/admin/hack-families/import-dismissals/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { normalizeNameKey, dismissDuplicatePair } from '@/lib/hackFamily';
import { PLATFORMS } from '@/types';

const importDismissalsSchema = z.object({
  pairs: z.array(z.object({
    platform: z.enum(PLATFORMS),
    nameA: z.string().min(1),
    nameB: z.string().min(1),
  })).min(1).max(2000),
});

// POST /api/admin/hack-families/import-dismissals
//
// Companion to a detailed-export re-import (see the `dismissedDuplicates`
// top-level key in src/lib/dat-generator.ts's export and
// extractDismissedDuplicates() in src/lib/dat-parser.ts) — re-creates
// "confirmed not a duplicate" decisions after a database rebuild, so an
// admin doesn't have to re-review the same pairs all over again. Called by
// src/components/ImportDatForm.tsx as one extra step AFTER all entry
// batches have finished, since families have to actually exist (from those
// entries) before a pair naming two of them can resolve to anything.
//
// Resolves each pair by name (normalized) + platform rather than trusting
// any id, since a fresh import creates brand new HackFamily rows — a pair
// only gets recorded if BOTH sides resolve to an existing family; anything
// that doesn't resolve (e.g. one side wasn't part of this import, or the
// name changed since the export was taken) is silently skipped, not an
// error — this is a best-effort restore, not a strict one.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const parsed = importDismissalsSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  let restored = 0;
  let skipped = 0;

  for (const pair of parsed.data.pairs) {
    const [famA, famB] = await Promise.all([
      prisma.hackFamily.findUnique({
        where: { nameKey_platform: { nameKey: normalizeNameKey(pair.nameA), platform: pair.platform } },
      }),
      prisma.hackFamily.findUnique({
        where: { nameKey_platform: { nameKey: normalizeNameKey(pair.nameB), platform: pair.platform } },
      }),
    ]);
    if (!famA || !famB || famA.id === famB.id) {
      skipped++;
      continue;
    }
    await dismissDuplicatePair(prisma, famA.id, famB.id, session.user.id);
    restored++;
  }

  return NextResponse.json({ restored, skipped });
}
