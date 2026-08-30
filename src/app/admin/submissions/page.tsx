// src/app/admin/submissions/page.tsx
import React from 'react';
import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { PlatformBadge } from '@/components/ui/PlatformBadge';
import { ScoreGauge } from '@/components/ui/ScoreGauge';
import { Avatar } from '@/components/ui/Avatar';
import { formatDistanceToNow } from 'date-fns';
import { SubmissionFilters } from '@/components/SubmissionFilters';
import { PlatformFilters } from '@/components/PlatformFilters';
import { PLATFORMS } from '@/types';
import { RestoreSubmissionButton } from '@/components/RestoreSubmissionButton';
import type { Prisma } from '@prisma/client';

export const dynamic = 'force-dynamic';

const STATUSES = ['PENDING', 'COMMUNITY_VERIFIED', 'RECOMMENDED', 'APPROVED', 'REJECTED', 'DISPUTED'];
const PER_PAGE = 50;

export default async function AdminSubmissionsPage({ searchParams }: { searchParams: { status?: string; platform?: string; page?: string; deleted?: string } }) {
  const deletedOnly = searchParams.deleted === 'true';

  // IMPORTANT: do NOT default this to 'PENDING'. An absent status param means
  // "All" was selected (SubmissionFilters deletes the param for that case) —
  // defaulting it here silently re-applies a PENDING filter while the pill
  // still displays "All" as active, which was the bug.
  const status = searchParams.status && STATUSES.includes(searchParams.status) ? searchParams.status : undefined;
  const platform = searchParams.platform && (PLATFORMS as readonly string[]).includes(searchParams.platform)
    ? searchParams.platform
    : undefined;
  const page = Math.max(1, parseInt(searchParams.page ?? '1'));

  // Deleted view shows ONLY soft-deleted items (any status), so admins can
  // review/restore without them cluttering the ordinary moderation queue.
  // The ordinary queue never shows soft-deleted items regardless of status
  // filter — deletedAt: null is unconditional there.
  const where: Prisma.SubmissionWhereInput = deletedOnly
    ? { deletedAt: { not: null } }
    : {
        deletedAt: null,
        ...(status ? { status: status as any } : {}),
        ...(platform ? { platform: platform as any } : {}),
      };

  const [total, submissions] = await Promise.all([
    prisma.submission.count({ where }),
    prisma.submission.findMany({
      where,
      include: {
        submittedBy: { select: { id: true, name: true, image: true, trustScore: true } },
        _count: { select: { verifications: true } },
      },
      orderBy: [{ verificationScore: 'desc' }, { createdAt: 'asc' }],
      skip: (page - 1) * PER_PAGE,
      take: PER_PAGE,
    }),
  ]);

  const totalPages = Math.ceil(total / PER_PAGE);
  const buildPageLink = (p: number) => {
    const params = new URLSearchParams();
    if (deletedOnly) { params.set('deleted', 'true'); }
    else {
      if (status) params.set('status', status);
      if (platform) params.set('platform', platform);
    }
    params.set('page', String(p));
    return `/admin/submissions?${params.toString()}`;
  };

  return (
    <div>
      <div className="flex flex-col gap-3 mb-6">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm text-text-muted">
            {total} submission(s){deletedOnly ? ' (deleted)' : ' sorted by verification score'}
          </p>
          <div className="flex items-center gap-3">
            {!deletedOnly && <SubmissionFilters current={status} />}
            <Link
              href={deletedOnly ? '/admin/submissions' : '/admin/submissions?deleted=true'}
              className={`text-xs px-2.5 py-1 rounded-md border ${deletedOnly ? 'border-phosphor/40 text-phosphor bg-phosphor/10' : 'border-border text-text-muted hover:text-phosphor'}`}
            >
              {deletedOnly ? '← Back to queue' : 'Deleted'}
            </Link>
          </div>
        </div>
        {!deletedOnly && <PlatformFilters current={platform} />}
      </div>

      {submissions.length === 0 && (
        <div className="text-center py-20 border border-dashed border-border rounded-xl text-text-muted">
          {deletedOnly ? 'No deleted submissions.' : 'Queue is empty for this status.'}
        </div>
      )}

      <div className="space-y-2">
        {submissions.map((sub) => (
          <div
            key={sub.id}
            className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-lg border border-border bg-bg-surface hover:border-phosphor/30 transition-colors group"
          >
            <Link href={`/submissions/${sub.id}`} className="flex items-center gap-3 min-w-0 flex-1">
              <Avatar src={sub.submittedBy.image} name={sub.submittedBy.name} size={36} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-medium text-text-primary group-hover:text-phosphor transition-colors truncate">
                    {sub.hackName} <span className="text-text-muted font-normal">v{sub.version}</span>
                  </h3>
                  <PlatformBadge platform={sub.platform} size="sm" />
                </div>
                <p className="text-xs text-text-muted mt-0.5">
                  {sub.submittedBy.name} ({sub.submittedBy.trustScore} trust) · {sub._count.verifications} verification(s) ·{' '}
                  {formatDistanceToNow(new Date(sub.createdAt), { addSuffix: true })}
                </p>
              </div>
            </Link>
            <div className="flex items-center gap-4 shrink-0">
              <ScoreGauge score={sub.verificationScore} />
              <StatusBadge status={sub.status} />
              {deletedOnly && <RestoreSubmissionButton submissionId={sub.id} />}
            </div>
          </div>
        ))}
      </div>

      {totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-8">
          {Array.from({ length: totalPages }, (_, i) => i + 1).slice(0, 10).map((p) => (
            <Link
              key={p}
              href={buildPageLink(p)}
              className={`w-8 h-8 flex items-center justify-center rounded-md text-xs font-mono ${
                p === page ? 'bg-phosphor text-bg-base' : 'text-text-muted hover:bg-bg-elevated'
              }`}
            >
              {p}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
