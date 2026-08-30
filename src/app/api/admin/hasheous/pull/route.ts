// src/app/api/admin/hasheous/pull/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { type HasheousEnv } from '@/lib/hasheous';
import { pullMappingForSubmission } from '@/lib/hasheousSync';
import { jobStore } from '@/lib/jobStore';
import { z } from 'zod';
import { randomUUID } from 'crypto';

const schema = z.object({
  submissionIds: z.array(z.string()).optional(),
  env: z.enum(['beta', 'production']).optional(),
  onlyMissing: z.boolean().optional(),
  // Skip entries whose GameMapping already has hasheousSyncStatus='ok' — the
  // primary "don't re-process 4k entries every time" guard. Defaults to true.
  skipSynced: z.boolean().optional(),
  overwrite: z.boolean().optional(),
  limit: z.number().int().min(1).max(10000).optional(),
  delayMs: z.number().int().min(0).max(5000).optional(),
});

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const {
    submissionIds, env, onlyMissing = true, skipSynced = true,
    overwrite = false, limit = 500, delayMs = 800,
  } = schema.parse(body);
  const hasheousEnv: HasheousEnv = env ?? (process.env.HASHEOUS_ENV as HasheousEnv) ?? 'beta';

  // Build the where clause once — passed into both count() and the job runner
  // so both are working from the same filter, avoiding count/actual mismatch.
  const where: any = {
    status: 'APPROVED',
    deletedAt: null,
    ...(submissionIds?.length ? { id: { in: submissionIds } } : {}),
  };

  if (onlyMissing && skipSynced) {
    // Most common case: skip anything already confirmed synced OR with no
    // mapping at all (no point trying things we've already found + things
    // we've already confirmed don't exist in Hasheous).
    // "Not synced" means: no GameMapping yet, OR mapping exists but sync
    // hasn't succeeded.
    where.OR = [
      { gameMappingId: null },
      { gameMapping: { hasheousSyncStatus: { not: 'ok' } } },
    ];
  } else if (onlyMissing) {
    where.gameMappingId = null;
  } else if (skipSynced) {
    where.OR = [
      { gameMappingId: null },
      { gameMapping: { hasheousSyncStatus: { not: 'ok' } } },
    ];
  }
  // if neither onlyMissing nor skipSynced, process everything (no extra filter)

  const total = await prisma.submission.count({ where });
  const toProcess = Math.min(total, limit);

  const jobId = randomUUID();
  jobStore.create(jobId, toProcess, hasheousEnv);

  const syncJob = await prisma.syncJob.create({
    data: {
      direction: 'PULL', env: hasheousEnv, status: 'RUNNING',
      triggeredBy: 'MANUAL', userId: session.user.id, total: toProcess,
    },
  });

  void runPullJob({
    jobId, syncJobId: syncJob.id, hasheousEnv, where, overwrite, limit, delayMs, userId: session.user.id,
  });

  return NextResponse.json({ jobId, syncJobId: syncJob.id, total: toProcess });
}

async function runPullJob({
  jobId, syncJobId, hasheousEnv, where, overwrite, limit, delayMs, userId,
}: {
  jobId: string; syncJobId: string; hasheousEnv: HasheousEnv; where: any;
  overwrite: boolean; limit: number; delayMs: number; userId: string;
}) {
  jobStore.update(jobId, (j) => { j.status = 'running'; });

  let cursor: string | undefined;
  let processed = 0;

  try {
    while (processed < limit) {
      const batch: any[] = await (prisma.submission.findMany as any)({
        where,
        select: {
          id: true, sha1: true, md5: true, crc32: true, hackName: true,
          gameMappingId: true,
        },
        orderBy: { id: 'asc' },
        take: Math.min(50, limit - processed),
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });

      if (batch.length === 0) break;
      cursor = batch[batch.length - 1].id;

      for (const sub of batch) {
        if (processed >= limit) break;
        if (processed > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

        const oneResult = await pullMappingForSubmission(sub, hasheousEnv, overwrite);

        if (oneResult.error) {
          jobStore.update(jobId, (j) => {
            j.processed++;
            j.notFound++;
            j.notFoundResults.push({ id: sub.id, hackName: sub.hackName, sha1: sub.sha1 });
          });
          processed++;
          continue;
        }

        if (!oneResult.found) {
          jobStore.update(jobId, (j) => {
            j.processed++;
            j.notFound++;
            j.notFoundResults.push({ id: sub.id, hackName: sub.hackName, sha1: sub.sha1 });
          });
          processed++;
          continue;
        }

        const appliedKeys = oneResult.appliedKeys;

        if (appliedKeys.length > 0) {
          await prisma.auditLog.create({
            data: {
              action: 'HASHEOUS_PULL_OK',
              details: { submissionId: sub.id, env: hasheousEnv, appliedKeys },
              userId, submissionId: sub.id,
            },
          });
        }

        jobStore.update(jobId, (j) => {
          j.processed++;
          j.found++;
          if (appliedKeys.length > 0) j.updated++;
          j.foundResults.push({ id: sub.id, hackName: sub.hackName, sha1: sub.sha1, mappingsApplied: appliedKeys });
        });

        processed++;
      }

      if (batch.length < 50) break;
    }

    jobStore.update(jobId, (j) => { j.status = 'done'; j.finishedAt = new Date().toISOString(); });
    const finalJob = jobStore.get(jobId);
    await prisma.syncJob.update({
      where: { id: syncJobId },
      data: {
        status: 'DONE', finishedAt: new Date(),
        processed: finalJob?.processed ?? 0, found: finalJob?.found ?? 0,
        updated: finalJob?.updated ?? 0, notFound: finalJob?.notFound ?? 0,
      },
    });
  } catch (err: any) {
    console.error('[hasheous] pull job error:', err?.message);
    jobStore.update(jobId, (j) => { j.status = 'error'; j.finishedAt = new Date().toISOString(); });
    const finalJob = jobStore.get(jobId);
    await prisma.syncJob.update({
      where: { id: syncJobId },
      data: {
        status: 'ERROR', finishedAt: new Date(), errorMessage: err?.message ?? 'Unknown error',
        processed: finalJob?.processed ?? 0, found: finalJob?.found ?? 0,
        updated: finalJob?.updated ?? 0, notFound: finalJob?.notFound ?? 0,
      },
    }).catch(() => {}); // don't let a logging failure mask the original error
  }
}
