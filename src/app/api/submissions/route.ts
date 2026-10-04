// src/app/api/submissions/route.ts
//
// Thin HTTP layer. The schema and the whole create sequence live in
// src/lib/submissionCreate.ts (moved there Sep 29 2026 so the bulk-submit
// flow can share the exact same code path rather than a second copy) — this
// file keeps only what is specific to a request: the session/ban/trust gate,
// the per-user rate limit, JSON parsing, and mapping SubmissionCreateError to
// a response.
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { checkSubmissionsRateLimit, checkBulkSubmissionsRateLimit, rateLimitedResponse } from '@/lib/rateLimit';
import { createSubmissionSchema, createSubmissionCore, SubmissionCreateError } from '@/lib/submissionCreate';
import { loadOpenBatch, BatchError } from '@/lib/submissionBatch';
import { areBulkSubmitsDisabled, BULK_SUBMIT_DISABLED_MESSAGE } from '@/lib/siteSettings';

// ─── GET /api/submissions ─────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1'));
  const perPage = Math.min(50, Math.max(1, parseInt(searchParams.get('perPage') ?? '20')));
  const status = searchParams.get('status');
  const platform = searchParams.get('platform');
  const tag = searchParams.get('tag');
  const search = searchParams.get('q');

  const where: Record<string, unknown> = {
    // Soft-deleted items are never visible through the public listing —
    // admins use the dedicated /admin/submissions?deleted=true view instead.
    deletedAt: null,
  };

  if (status) {
    where.status = status;
  }

  if (platform) {
    where.platform = platform;
  }

  if (tag) {
    where.tags = { some: { tag: { slug: tag } } };
  }

  if (search) {
    where.OR = [
      { hackName: { contains: search, mode: 'insensitive' } },
      { author: { contains: search, mode: 'insensitive' } },
      { sha1: { contains: search, mode: 'insensitive' } },
      { md5: { contains: search, mode: 'insensitive' } },
      { crc32: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [total, submissions] = await Promise.all([
    prisma.submission.count({ where }),
    prisma.submission.findMany({
      where,
      include: {
        submittedBy: { select: { id: true, name: true, image: true, username: true, trustScore: true } },
        tags: { include: { tag: true } },
        _count: { select: { verifications: true, comments: true } },
      },
      orderBy: [{ verificationScore: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  return NextResponse.json({
    items: submissions,
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  });
}

// ─── POST /api/submissions ────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (session.user.isBanned) {
    return NextResponse.json({ error: 'Your account has been banned' }, { status: 403 });
  }

  if (session.user.trustScore < -50) {
    return NextResponse.json({ error: 'Account suspended due to low trust score' }, { status: 403 });
  }

  // Body is read BEFORE the rate limit now (it used to be after) because the
  // limiter to charge depends on whether this request belongs to a bulk
  // batch. Reading a small JSON body first costs nothing meaningful. For an
  // ordinary request the rate limit still runs before any database work or
  // schema validation; a batch request does one indexed lookup first (to
  // prove the batch is real and the caller's) — see below.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Bulk submit: a row sent under a batch carries `batchId` next to the
  // normal fields (kept out of createSubmissionSchema on purpose — it isn't
  // part of a submission's data, it's a grouping handle). The claim is
  // verified here BEFORE it's allowed to pick the bulk rate limiter — it
  // must be the caller's own batch, unwithdrawn and still open — so
  // claiming to be a bulk request can't be used to dodge the stricter
  // single-submission limit. The kill switch is checked first so a paused
  // feature refuses cleanly instead of half-working.
  let batchId: string | undefined;
  const claimedBatchId = body && typeof body === 'object' ? (body as Record<string, unknown>).batchId : undefined;
  if (claimedBatchId !== undefined && claimedBatchId !== null) {
    if (typeof claimedBatchId !== 'string' || claimedBatchId.length === 0 || claimedBatchId.length > 64) {
      return NextResponse.json({ error: 'Invalid batchId' }, { status: 400 });
    }
    if (await areBulkSubmitsDisabled()) {
      return NextResponse.json({ error: BULK_SUBMIT_DISABLED_MESSAGE, bulkDisabled: true }, { status: 503 });
    }
    try {
      await loadOpenBatch(claimedBatchId, session.user.id);
    } catch (err) {
      if (err instanceof BatchError) return NextResponse.json({ error: err.message }, { status: err.status });
      throw err;
    }
    batchId = claimedBatchId;
  }

  // Keyed by user id, not IP — see src/lib/rateLimit.ts for why. Checked
  // after the cheap session/ban/trust/batch checks and before any actual
  // work so a rate-limited request never reaches it.
  const submissionsLimit = batchId
    ? await checkBulkSubmissionsRateLimit(session.user.id)
    : await checkSubmissionsRateLimit(session.user.id);
  if (!submissionsLimit.success) {
    return rateLimitedResponse(submissionsLimit);
  }

  const parsed = createSubmissionSchema.safeParse(body);
  if (!parsed.success) {
    // Logged server-side (not just returned to the client) specifically so
    // this shows up directly in the terminal running `npm start` — the
    // same place build errors already get seen and pasted back, rather
    // than requiring a trip into browser devtools to read the response
    // body just to find out which field actually failed.
    console.error('POST /api/submissions validation failed:', JSON.stringify(parsed.error.flatten()));
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 });
  }

  try {
    const { submission, potentialDuplicates, promotedToContributor, alreadyCreated } = await createSubmissionCore(
      parsed.data,
      session.user.id,
      { batchId }
    );
    return NextResponse.json(
      {
        submission: { ...submission, fileSize: submission.fileSize.toString() },
        potentialDuplicates,
        promotedToContributor,
        // Only present (and only ever true) for a bulk retry that found its
        // own earlier row — absent from every ordinary response, so those
        // are byte-for-byte what they were.
        ...(alreadyCreated ? { alreadyCreated: true } : {}),
      },
      { status: alreadyCreated ? 200 : 201 }
    );
  } catch (err) {
    if (err instanceof SubmissionCreateError) {
      return NextResponse.json(err.body, { status: err.status });
    }
    throw err;
  }
}
