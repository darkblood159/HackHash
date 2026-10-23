// src/app/api/admin/hasheous/status/route.ts
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getHasheousBaseUrl, type HasheousEnv } from '@/lib/hasheous';
import { prisma } from '@/lib/prisma';
import {
  PULL_INTERVAL_MS, NOT_FOUND_RECHECK_MS, SYNCED_REFRESH_MS, PULL_BATCH, REFRESH_BATCH,
  WAVE_REFRESH_BATCH,
} from '@/lib/syncConfig';
import { WAVE_SETTING_KEY, fetchHasheousSchedule, isWaveActive, parseWaveState } from '@/lib/hasheousIngestWatch';
import { waveDueWhere } from '@/lib/syncScheduler';

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

  // Post-import refresh wave: persisted state, how many entries it still owes
  // a check, and Hasheous's own view of when it last/next imports our DAT
  // (one anonymous GET; fail-soft — the card just omits it if unreachable).
  const env = (process.env.HASHEOUS_ENV as HasheousEnv | undefined) ?? 'beta';
  const waveRow = await prisma.siteSetting.findUnique({ where: { key: WAVE_SETTING_KEY } }).catch(() => null);
  const wave = parseWaveState(waveRow?.value);
  const waveRemaining = isWaveActive(wave)
    ? await prisma.submission.count({ where: waveDueWhere(new Date(wave.readyAt)) }).catch(() => null)
    : null;
  const live = await fetchHasheousSchedule(getHasheousBaseUrl(env));
  const iso = (t: number | null | undefined) => (t != null ? new Date(t).toISOString() : null);
  const hasheousImport = live.ok && live.schedule.ingest
    ? {
        state: live.schedule.ingest.state,
        lastFinishedAt: iso(live.schedule.ingest.lastFinishTime),
        nextRunAt: iso(live.schedule.ingest.nextRunTime),
      }
    : null;

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
      waveBatch: WAVE_REFRESH_BATCH,
    },
    wave,
    waveRemaining,
    hasheousImport,
    lastAutoPull,
  });
}
