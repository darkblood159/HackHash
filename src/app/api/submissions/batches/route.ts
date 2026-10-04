// src/app/api/submissions/batches/route.ts
//
// Bulk submit, step one: what the caller is allowed to do (GET), and starting
// a batch (POST). A batch is only a grouping/undo handle — see
// prisma/schema.prisma (SubmissionBatch) and src/lib/bulkLimits.ts. It is
// created when the person actually presses Submit (not when the page loads),
// so simply looking at the bulk screen never uses up the per-day allowance.
//
// (A static segment, so it wins over the dynamic /api/submissions/[id]
// route, same as /api/submissions/check-duplicate.)
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { PLATFORMS } from '@/types';
import { areBulkSubmitsDisabled, BULK_SUBMIT_DISABLED_MESSAGE } from '@/lib/siteSettings';
import { getBulkLimitsForUser, countRecentBatches, createBatchForUser, BatchError } from '@/lib/submissionBatch';

async function requireUser() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const;
  if (session.user.isBanned) return { error: NextResponse.json({ error: 'Your account has been banned' }, { status: 403 }) } as const;
  if (session.user.trustScore < -50) {
    return { error: NextResponse.json({ error: 'Account suspended due to low trust score' }, { status: 403 }) } as const;
  }
  return { userId: session.user.id } as const;
}

// GET: is bulk on, and how much may this account do right now.
export async function GET() {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;

  const [disabled, limits, used] = await Promise.all([
    areBulkSubmitsDisabled(),
    getBulkLimitsForUser(auth.userId),
    countRecentBatches(auth.userId),
  ]);
  return NextResponse.json({
    enabled: !disabled,
    disabledMessage: disabled ? BULK_SUBMIT_DISABLED_MESSAGE : null,
    limits,
    batchesUsedToday: used,
  });
}

const createBatchSchema = z.object({
  // Same ceiling as createSubmissionSchema.hackName.
  hackName: z.string().trim().min(1).max(200),
  platform: z.enum(PLATFORMS),
});

// POST: start a batch for one hack. Returns the id every following row
// (POST /api/submissions with `batchId`) and patch upload is sent under.
export async function POST(req: Request) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;

  if (await areBulkSubmitsDisabled()) {
    return NextResponse.json({ error: BULK_SUBMIT_DISABLED_MESSAGE, bulkDisabled: true }, { status: 503 });
  }

  const body = await req.json().catch(() => null);
  const parsed = createBatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 });
  }

  try {
    const { batch, limits, batchesUsedToday } = await createBatchForUser(auth.userId, parsed.data);
    return NextResponse.json({ batch: { id: batch.id }, limits, batchesUsedToday }, { status: 201 });
  } catch (err) {
    if (err instanceof BatchError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
