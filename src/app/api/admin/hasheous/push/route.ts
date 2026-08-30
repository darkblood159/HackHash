// src/app/api/admin/hasheous/push/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { pushMappingToHasheous, getHasheousBaseUrl, type HasheousEnv } from '@/lib/hasheous';
import { recordAcceptedPushResult } from '@/lib/hasheousSync';
import { z } from 'zod';

const schema = z.object({
  submissionIds: z.array(z.string()).optional(),
  env: z.enum(['beta', 'production']).optional(),
});

interface PushResult {
  id: string;
  hackName: string;
  sha1: string;
  ok: boolean;
  skipped?: boolean;
  skipReason?: string;
  error?: string;
  // What mapping IDs were actually sent so the admin can see what changed
  sentMappings?: Record<string, string>;
  // Per-source outcome from Hasheous's own FixMatch response — which of the
  // sent fields it actually accepted as a vote vs rejected outright (e.g. a
  // stale/invalid id). Undefined if the response wasn't parseable.
  accepted?: string[];
  rejected?: Record<string, string>;
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const { submissionIds, env } = schema.parse(body);
  const hasheousEnv: HasheousEnv = env ?? (process.env.HASHEOUS_ENV as HasheousEnv) ?? 'beta';

  // Deliberately NOT filtering by `gameMapping: { isNot: null }` here. A
  // submission with no GameMapping row yet (nobody has pulled it from
  // Hasheous or manually added a DB link) used to be excluded from this
  // query entirely — invisible, not "skipped". It now comes through and is
  // reported explicitly below so it's clear why nothing was sent for it.
  const submissions = await prisma.submission.findMany({
    where: {
      status: 'APPROVED',
      deletedAt: null,
      ...(submissionIds?.length ? { id: { in: submissionIds } } : {}),
    },
    select: {
      id: true, sha1: true, md5: true, crc32: true, hackName: true, gameMapping: true,
    },
    take: 100,
  });

  const job = await prisma.syncJob.create({
    data: {
      direction: 'PUSH', env: hasheousEnv, status: 'RUNNING',
      triggeredBy: 'MANUAL', userId: session.user.id, total: submissions.length,
    },
  });

  const results: PushResult[] = [];

  for (const sub of submissions) {
    const m = sub.gameMapping as any;
    if (!m) {
      results.push({
        id: sub.id, hackName: sub.hackName, sha1: sub.sha1,
        ok: false, skipped: true,
        skipReason: 'No game database links yet — add one via edit/change-request or pull from Hasheous first',
      });
      continue;
    }

    // Build the mapping payload — only include fields that are actually set
    const sentMappings: Record<string, string> = {};
    if (m.igdbId)              sentMappings.igdbId              = m.igdbId;
    if (m.theGamesDBId)        sentMappings.theGamesDBId        = m.theGamesDBId;
    if (m.giantBombId)         sentMappings.giantBombId         = m.giantBombId;
    if (m.launchboxId)         sentMappings.launchboxId         = m.launchboxId;
    if (m.screenScraperId)     sentMappings.screenScraperId     = m.screenScraperId;
    if (m.steamGridDBId)       sentMappings.steamGridDBId       = m.steamGridDBId;
    if (m.retroAchievementsId) sentMappings.retroAchievementsId = m.retroAchievementsId;
    if (m.gogId)               sentMappings.gogId               = m.gogId;
    if (m.epicGamesId)         sentMappings.epicGamesId         = m.epicGamesId;

    if (Object.keys(sentMappings).length === 0) {
      results.push({
        id: sub.id, hackName: sub.hackName, sha1: sub.sha1,
        ok: false, skipped: true, skipReason: 'No mapping IDs filled in — nothing to push',
      });
      continue;
    }

    const result = await pushMappingToHasheous(
      {
        hashes: { crc32: sub.crc32, md5: sub.md5, sha1: sub.sha1 },
        mappings: sentMappings as any,
      },
      hasheousEnv
    );

    await prisma.gameMapping.update({
      where: { id: m.id },
      data: {
        hasheousSyncedAt: new Date(),
        hasheousSyncStatus: result.ok ? 'ok' : 'error',
        hasheousSyncError: result.error ?? null,
      },
    });

    if (result.ok) {
      await recordAcceptedPushResult(m.id, sentMappings as any, result);
    }

    await prisma.auditLog.create({
      data: {
        action: result.ok ? 'HASHEOUS_PUSH_OK' : 'HASHEOUS_PUSH_ERROR',
        details: {
          submissionId: sub.id, env: hasheousEnv, sentMappings, error: result.error ?? null,
          accepted: result.accepted ?? null, rejected: result.rejected ?? null,
        },
        userId: session.user.id,
        submissionId: sub.id,
      },
    });

    results.push({
      id: sub.id, hackName: sub.hackName, sha1: sub.sha1,
      ok: result.ok, error: result.error, sentMappings,
      accepted: result.accepted, rejected: result.rejected,
    });
  }

  const pushed = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => !r.ok && !r.skipped).length;

  await prisma.syncJob.update({
    where: { id: job.id },
    data: {
      status: 'DONE', processed: results.length, pushed, skipped, failed,
      finishedAt: new Date(),
    },
  });

  return NextResponse.json({
    jobId: job.id,
    env: hasheousEnv,
    baseUrl: getHasheousBaseUrl(hasheousEnv),
    total: results.length,
    pushed,
    skipped,
    failed,
    results,
  });
}
