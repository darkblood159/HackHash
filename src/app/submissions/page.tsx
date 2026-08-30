// src/app/submissions/page.tsx
import React from 'react';
import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { PlatformBadge } from '@/components/ui/PlatformBadge';
import { TagBadge } from '@/components/ui/TagBadge';
import { ScoreGauge } from '@/components/ui/ScoreGauge';
import { Avatar } from '@/components/ui/Avatar';
import { formatDistanceToNow } from 'date-fns';
import { SubmissionFilters } from '@/components/SubmissionFilters';
import { PlatformFilters } from '@/components/PlatformFilters';
import { TagFilters } from '@/components/TagFilters';
import { PLATFORMS } from '@/types';

export const dynamic = 'force-dynamic';

const STATUSES = ['PENDING', 'COMMUNITY_VERIFIED', 'RECOMMENDED', 'APPROVED', 'REJECTED', 'DISPUTED'];

export default async function SubmissionsPage({
  searchParams,
}: {
  searchParams: { status?: string; platform?: string; tag?: string };
}) {
  const status = searchParams.status && STATUSES.includes(searchParams.status) ? searchParams.status : undefined;
  const platform = searchParams.platform && (PLATFORMS as readonly string[]).includes(searchParams.platform)
    ? searchParams.platform
    : undefined;
  const tag = searchParams.tag;

  const submissions = await prisma.submission.findMany({
    where: {
      deletedAt: null,
      ...(status ? { status: status as any } : {}),
      ...(platform ? { platform: platform as any } : {}),
      ...(tag ? { tags: { some: { tag: { slug: tag } } } } : {}),
    },
    include: {
      submittedBy: { select: { id: true, name: true, image: true, username: true } },
      tags: { include: { tag: true } },
      _count: { select: { verifications: true, comments: true } },
    },
    orderBy: [{ verificationScore: 'desc' }, { createdAt: 'desc' }],
    take: 50,
  });

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-12">
      <div className="flex flex-col gap-4 mb-8">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <span className="text-phosphor text-xs font-mono uppercase tracking-widest">Review queue</span>
            <h1 className="font-display text-3xl font-bold mt-2">Submissions</h1>
          </div>
          <SubmissionFilters current={status} />
        </div>
        <PlatformFilters current={platform} />
        <TagFilters current={tag} />
      </div>

      {submissions.length === 0 && (
        <div className="text-center py-20 border border-dashed border-border rounded-xl text-text-muted">
          No submissions match this filter.
        </div>
      )}

      <div className="space-y-2">
        {submissions.map((sub) => (
          <div
            key={sub.id}
            className="relative flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-lg border border-border bg-bg-surface hover:border-phosphor/30 transition-colors group"
          >
            {/* Covers the whole card so clicking anywhere navigates to the
                submission — placed first so it sits BELOW the tag badges
                below in paint order, keeping them independently clickable.
                Previously the tag badges were literally nested inside this
                same link (invalid HTML — an <a> inside an <a>), which is why
                clicking a tag reliably did nothing except open the
                submission itself instead of filtering by that tag. */}
            <Link href={`/submissions/${sub.id}`} className="absolute inset-0" aria-label={sub.hackName} />

            <Avatar src={sub.submittedBy.image} name={sub.submittedBy.name} size={36} />

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-medium text-text-primary group-hover:text-phosphor transition-colors truncate">
                  {sub.hackName}
                </h3>
                <span className="text-text-muted text-sm">v{sub.version}</span>
                <PlatformBadge platform={sub.platform} size="sm" />
              </div>
              <p className="text-xs text-text-muted mt-0.5">
                {sub.author && <>by {sub.author} · </>}submitted {formatDistanceToNow(new Date(sub.createdAt), { addSuffix: true })} ·{' '}
                {sub._count.verifications} verification{sub._count.verifications !== 1 ? 's' : ''}
              </p>
              {sub.tags.length > 0 && (
                <div className="relative flex gap-1 mt-1.5 flex-wrap">
                  {sub.tags.map(({ tag: t }) => (
                    <TagBadge
                      key={t.id}
                      name={t.name}
                      slug={t.slug}
                      href={`/submissions?${platform ? `platform=${platform}&` : ''}tag=${t.slug}`}
                      active={tag === t.slug}
                      description={t.description}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="relative flex items-center gap-4 shrink-0">
              <ScoreGauge score={sub.verificationScore} />
              <StatusBadge status={sub.status} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
