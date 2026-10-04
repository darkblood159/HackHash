// src/app/api/admin/patches/organize/route.ts
//
// POST { dryRun?: boolean, limit?: number } — files every uploaded patch into
// the Platform/Base ROM/Hack folder layout (see src/lib/patchOrganize.ts for
// the full safety model). dryRun (the default — a real run must be asked for
// explicitly) only reports what WOULD move. A real run handles at most `limit`
// patches per call, and stops starting new files after a time budget (the
// request goes through Cloudflare's ~100 s cap), and reports how many remain;
// the admin UI calls again until none do. Admin-only, like the other patch-storage repair tools.

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { organizePatchFiles } from '@/lib/patchOrganize';

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: { dryRun?: unknown; limit?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // an empty body is fine — it means "dry run, default limit"
  }
  const dryRun = body.dryRun !== false;
  const limit = typeof body.limit === 'number' && Number.isFinite(body.limit) ? body.limit : undefined;

  try {
    const result = await organizePatchFiles({ dryRun, limit });

    if (!dryRun && result.moved > 0) {
      await prisma.auditLog.create({
        data: {
          action: 'PATCH_FILES_ORGANIZED',
          details: {
            moved: result.moved,
            remaining: result.remaining,
            problems: result.problems.length,
          },
          userId: session.user.id,
        },
      });
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error('[patch organize] failed:', err);
    return NextResponse.json({ error: 'Organizing patch files failed — see the server log.' }, { status: 500 });
  }
}
