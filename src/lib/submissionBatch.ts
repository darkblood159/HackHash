// src/lib/submissionBatch.ts
//
// Server-side helpers for bulk-submit batches (the SubmissionBatch model —
// see prisma/schema.prisma for what a batch is, and src/lib/bulkLimits.ts
// for every tunable number). A batch is a grouping/undo handle: rows created
// under one are ordinary PENDING submissions and go through normal
// verification. Nothing here grants any shortcut to approval.

import { prisma } from './prisma';
import { getTrustTier } from './trust';
import { bulkLimitsFor, BULK_BATCH_OPEN_HOURS, type BulkLimits } from './bulkLimits';

/** A refusal with the HTTP status the route should answer with. */
export class BatchError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Limits for this account, from the LIVE database row — not the session,
 * whose role/trustScore can be stale until the next token refresh (the same
 * reason createSubmissionCore reads the role from the database).
 */
export async function getBulkLimitsForUser(userId: string): Promise<BulkLimits> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { trustScore: true, role: true } });
  if (!user) throw new BatchError(401, 'Account not found');
  return bulkLimitsFor(getTrustTier(user.trustScore), user.role);
}

/**
 * Loads a batch that `userId` may still add to. "Not found" and "not yours"
 * are deliberately the same 404, so a caller can't probe which batch ids
 * exist. Throws BatchError otherwise.
 */
export async function loadOpenBatch(batchId: string, userId: string) {
  const batch = await prisma.submissionBatch.findUnique({ where: { id: batchId } });
  if (!batch || batch.submittedById !== userId) {
    throw new BatchError(404, 'Batch not found — start a new one.');
  }
  if (batch.reversed) {
    throw new BatchError(409, 'This batch was withdrawn by a moderator, so nothing more can be added to it.');
  }
  const ageMs = Date.now() - batch.createdAt.getTime();
  if (ageMs > BULK_BATCH_OPEN_HOURS * 60 * 60 * 1000) {
    throw new BatchError(409, 'This batch is too old to add to — start a new one.');
  }
  return batch;
}

/** Batches this account started in the last 24 hours, not counting withdrawn ones. */
export async function countRecentBatches(userId: string): Promise<number> {
  return prisma.submissionBatch.count({
    where: {
      submittedById: userId,
      reversed: false,
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
  });
}

/** Rows already in a batch. Counts soft-deleted ones too — they still used a slot. */
export async function countBatchRows(batchId: string): Promise<number> {
  return prisma.submission.count({ where: { batchId } });
}

/**
 * Starts a new batch, enforcing the per-day cap. The cap is counted from the
 * database (like the row cap), so it holds even when Upstash rate limiting
 * isn't configured.
 */
export async function createBatchForUser(userId: string, header: { hackName: string; platform: string }) {
  const limits = await getBulkLimitsForUser(userId);
  const recent = await countRecentBatches(userId);
  if (recent >= limits.maxBatchesPerDay) {
    throw new BatchError(
      429,
      `You've started ${recent} bulk batch${recent === 1 ? '' : 'es'} in the last 24 hours, which is the limit for your account right now. ` +
        'You can still submit versions one at a time, or try again later.'
    );
  }
  const batch = await prisma.submissionBatch.create({
    data: { submittedById: userId, hackName: header.hackName, platform: header.platform as never },
  });
  return { batch, limits, batchesUsedToday: recent + 1 };
}
