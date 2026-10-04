// src/app/api/admin/hasheous/status/route.ts
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getHasheousBaseUrl } from '@/lib/hasheous';
import { prisma } from '@/lib/prisma';
import {
  PULL_INTERVAL_MS, NOT_FOUND_RECHECK_MS, SYNCED_REFRESH_MS, PULL_BATCH, REFRESH_BATCH,
} from '@/lib/syncConfig';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Most recent AUTOMATIC pull, so the admin can see the schedule is actually
  // running. Note a cycle with nothing to do records no job at all.
  const lastAutoPull = await prisma.syncJob.findFirst({
    where: { direction: 'PULL', triggeredBy: 'SCHEDULER' },
    orderBy: { startedAt: 'desc' },
    select: {
      startedAt: true, finishedAt: true, status: true, env: true,
      processed: true, found: true, updated: true, notFound: true, errorMessage: true,
    },
  });

  return NextResponse.json({
    apiKeyConfigured: !!process.env.HASHEOUS_API_KEY,
    env: process.env.HASHEOUS_ENV ?? 'beta',
    betaUrl: getHasheousBaseUrl('beta'),
    productionUrl: getHasheousBaseUrl('production'),
    schedule: {
      pullEveryMs: PULL_INTERVAL_MS,
      recheckUnresolvedMs: NOT_FOUND_RECHECK_MS,
      refreshSyncedMs: SYNCED_REFRESH_MS,
      pullBatch: PULL_BATCH,
      refreshBatch: REFRESH_BATCH,
    },
    lastAutoPull,
  });
}
