// src/app/admin/batches/page.tsx
//
// Bulk-submit batches, newest first: who started each, what it covers, how
// its rows stand, and a one-step "reject pending" (src/components/
// RejectBatchButton.tsx). Same server-component-plus-small-client-button
// shape as the DAT import history on /admin/import.
import React from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { prisma } from '@/lib/prisma';
import { PlatformBadge } from '@/components/ui/PlatformBadge';
import { RejectBatchButton } from '@/components/RejectBatchButton';

export const dynamic = 'force-dynamic';

async function getBatches() {
  const batches = await prisma.submissionBatch.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  const ids = batches.map((b) => b.id);
  const userIds = Array.from(new Set(batches.map((b) => b.submittedById)));

  const [grouped, users] = await Promise.all([
    ids.length
      ? prisma.submission.groupBy({ by: ['batchId', 'status'], where: { batchId: { in: ids } }, _count: { _all: true } })
      : Promise.resolve([]),
    userIds.length
      ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, username: true } })
      : Promise.resolve([]),
  ]);

  const userMap = Object.fromEntries(users.map((u) => [u.id, u.name ?? u.username ?? 'Unknown']));
  const counts: Record<string, Record<string, number>> = {};
  for (const g of grouped) {
    if (!g.batchId) continue;
    (counts[g.batchId] ??= {})[g.status] = g._count._all;
  }

  return batches.map((b) => {
    const c = counts[b.id] ?? {};
    const total = Object.values(c).reduce((a, n) => a + n, 0);
    return { ...b, byName: userMap[b.submittedById] ?? 'Unknown', counts: c, total };
  });
}

const STATUS_ORDER = ['PENDING', 'APPROVED', 'REJECTED'] as const;

export default async function AdminBatchesPage() {
  const batches = await getBatches().catch(() => []);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl font-bold">Bulk batches</h1>
        <p className="text-text-secondary text-sm mt-1 max-w-2xl">
          Each row below is one "submit several versions at once" session. Its entries are ordinary pending
          submissions that go through normal verification. If a whole batch is wrong — say the wrong base ROM was
          picked once and applied to every version — reject its pending entries here in one step. Entries already
          approved by the community are left alone, and no trust penalty is applied.
        </p>
      </div>

      {batches.length === 0 && (
        <p className="text-sm text-text-muted py-8 text-center border border-dashed border-border rounded-lg">
          No bulk batches yet.
        </p>
      )}

      <div className="space-y-2">
        {batches.map((b) => (
          <div
            key={b.id}
            className="p-4 rounded-lg border border-border bg-bg-surface flex items-center justify-between gap-4 flex-wrap"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-text-primary font-medium truncate">{b.hackName}</span>
                <PlatformBadge platform={b.platform} />
                {b.reversed && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-rejected-bg text-status-rejected">Withdrawn</span>
                )}
              </div>
              <p className="text-xs text-text-muted mt-1">
                {b.byName} · {format(b.createdAt, 'MMM d, yyyy h:mm a')} ·{' '}
                {b.total === 0 ? 'no entries created' : `${b.total} ${b.total === 1 ? 'entry' : 'entries'}`}
                {STATUS_ORDER.filter((s) => b.counts[s]).map((s) => ` · ${b.counts[s]} ${s.toLowerCase()}`)}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Link
                href={`/admin/submissions?batchId=${b.id}`}
                className="text-xs px-2 py-1 rounded border border-border text-text-muted hover:text-text-primary hover:bg-bg-elevated"
              >
                View entries
              </Link>
              {!b.reversed && (b.counts.PENDING ?? 0) > 0 && (
                <RejectBatchButton batchId={b.id} pendingCount={b.counts.PENDING ?? 0} />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
