// src/app/api/submissions/precheck/route.ts
//
// Bulk submit's DRY RUN. Given the shared header and the table of rows,
// reports every problem the database can see — exact-duplicate files,
// repeats inside the batch, a "hack" that's really the base ROM, a version
// label that already exists — so the review table can show them all before
// anything is written. Writes nothing. The same checks are re-enforced,
// server-side, when a row is actually created under a batch
// (createSubmissionCore), so this endpoint is a convenience for the person,
// never the thing standing between them and the data. See
// src/lib/bulkChecks.ts.
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { PLATFORMS } from '@/types';
import { checkBulkPrecheckRateLimit, rateLimitedResponse } from '@/lib/rateLimit';
import { areBulkSubmitsDisabled, BULK_SUBMIT_DISABLED_MESSAGE } from '@/lib/siteSettings';
import { BULK_PRECHECK_MAX_ROWS } from '@/lib/bulkLimits';
import { checkBulkRows } from '@/lib/bulkChecks';

const precheckSchema = z.object({
  hackName: z.string().trim().min(1).max(200),
  platform: z.enum(PLATFORMS),
  // Optional: the dry run is useful before a base ROM is picked (duplicate
  // files, repeats, existing version labels). Omitted = no base-ROM checks.
  baseRomId: z.string().min(1).max(64).optional(),
  rows: z
    .array(
      z.object({
        clientId: z.string().min(1).max(64),
        version: z.string().max(50),
        sha1: z.string().regex(/^[0-9a-f]{40}$/i),
      })
    )
    .min(1)
    .max(BULK_PRECHECK_MAX_ROWS),
});

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.isBanned) return NextResponse.json({ error: 'Your account has been banned' }, { status: 403 });

  if (await areBulkSubmitsDisabled()) {
    return NextResponse.json({ error: BULK_SUBMIT_DISABLED_MESSAGE, bulkDisabled: true }, { status: 503 });
  }

  const limit = await checkBulkPrecheckRateLimit(session.user.id);
  if (!limit.success) return rateLimitedResponse(limit);

  const body = await req.json().catch(() => null);
  const parsed = precheckSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 });
  }

  return NextResponse.json(await checkBulkRows({ ...parsed.data, baseRomId: parsed.data.baseRomId ?? null }));
}
