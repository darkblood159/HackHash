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
import { PatchFilters } from '@/components/PatchFilters';
import { FranchiseFilter } from '@/components/FranchiseFilter';
import { getFranchiseFilterOptions } from '@/lib/franchise';
import { PLATFORMS } from '@/types';

export const dynamic = 'force-dynamic';

const STATUSES = ['PENDING', 'COMMUNITY_VERIFIED', 'RECOMMENDED', 'APPROVED', 'REJECTED', 'DISPUTED'];

export default async function SubmissionsPage({
  searchParams,
}: {
  searchParams: { status?: string; platform?: string; tag?: string; baseRomId?: string; hasPatch?: string; franchise?: string; author?: string };
}) {
  const status = searchParams.status && STATUSES.includes(searchParams.status) ? searchParams.status : undefined;
  const platform = searchParams.platform && (PLATFORMS as readonly string[]).includes(searchParams.platform)
    ? searchParams.platform
    : undefined;
  const tag = searchParams.tag;
  // Same validate-against-a-known-set treatment as status/platform above —
  // anything other than exactly 'yes'/'no' falls back to "no filter"
  // rather than silently building a where clause around an unrecognized
  // value. Checks patchUploadedAt (the real "file is attached" flag, see
  // its own comment in prisma/schema.prisma), not patchType/patchSha1,
  // which can be set with no file ever uploaded.
  const hasPatch = searchParams.hasPatch === 'yes' || searchParams.hasPatch === 'no' ? searchParams.hasPatch : undefined;

  // Resolved (not just trusted-as-is) the same way status/platform above
  // are checked against a known-valid set before use — a stale/mistyped id
  // falls back to "no filter" rather than silently sending a where clause
  // that would just return zero rows with no explanation. Needs its own
  // lookup (not just a raw id passthrough) regardless, since the banner
  // below has to show a human-readable name, not the id itself.
  const baseRomFilter = searchParams.baseRomId
    ? await prisma.baseRom.findUnique({
        where: { id: searchParams.baseRomId },
        select: { id: true, name: true, platform: true, fileExtension: true },
      })
    : null;

  // Same stale-id-falls-back-to-no-filter treatment as baseRomFilter above.
  const franchiseFilter = searchParams.franchise
    ? await prisma.franchise.findUnique({ where: { id: searchParams.franchise }, select: { id: true, name: true } })
    : null;
  const franchiseOptions = await getFranchiseFilterOptions(prisma, 'submissions', franchiseFilter);
  // Exact (case-insensitive) author-name match — see the matching comment
  // in src/app/entries/page.tsx for why this isn't a "contains".
  const author = searchParams.author?.trim() || undefined;

  const submissions = await prisma.submission.findMany({
    where: {
      deletedAt: null,
      ...(status ? { status: status as any } : {}),
      ...(platform ? { platform: platform as any } : {}),
      ...(tag ? { tags: { some: { tag: { slug: tag } } } } : {}),
      ...(baseRomFilter ? { baseRomId: baseRomFilter.id } : {}),
      ...(franchiseFilter ? { franchiseId: franchiseFilter.id } : {}),
      ...(author ? { author: { equals: author, mode: 'insensitive' as const } } : {}),
      ...(hasPatch === 'yes' ? { patchUploadedAt: { not: null } } : {}),
      ...(hasPatch === 'no' ? { patchUploadedAt: null } : {}),
    },
    include: {
      submittedBy: { select: { id: true, name: true, image: true, username: true } },
      tags: { include: { tag: true } },
      franchise: { select: { id: true, name: true } },
      _count: { select: { verifications: true, comments: true } },
    },
    orderBy: [{ verificationScore: 'desc' }, { createdAt: 'desc' }],
    take: 50,
  });

  // Manually rebuilt (rather than reading useSearchParams, which needs a
  // client component) the same way entries/page.tsx's buildPageLink already
  // does — preserves every OTHER active filter, drops only baseRomId.
  const clearBaseRomParams = new URLSearchParams();
  if (status) clearBaseRomParams.set('status', status);
  if (platform) clearBaseRomParams.set('platform', platform);
  if (tag) clearBaseRomParams.set('tag', tag);
  if (hasPatch) clearBaseRomParams.set('hasPatch', hasPatch);
  if (franchiseFilter) clearBaseRomParams.set('franchise', franchiseFilter.id);
  if (author) clearBaseRomParams.set('author', author);
  const clearBaseRomHref = `/submissions${clearBaseRomParams.toString() ? `?${clearBaseRomParams.toString()}` : ''}`;

  // Drops only the author filter, keeps every other active one — same
  // approach as clearBaseRomHref above.
  const clearAuthorParams = new URLSearchParams();
  if (status) clearAuthorParams.set('status', status);
  if (platform) clearAuthorParams.set('platform', platform);
  if (tag) clearAuthorParams.set('tag', tag);
  if (hasPatch) clearAuthorParams.set('hasPatch', hasPatch);
  if (baseRomFilter) clearAuthorParams.set('baseRomId', baseRomFilter.id);
  if (franchiseFilter) clearAuthorParams.set('franchise', franchiseFilter.id);
  const clearAuthorHref = `/submissions${clearAuthorParams.toString() ? `?${clearAuthorParams.toString()}` : ''}`;

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
        <PatchFilters current={hasPatch} />
        <FranchiseFilter options={franchiseOptions} current={franchiseFilter?.id} />
        {author && (
          <div className="flex items-center gap-2 flex-wrap px-3 py-2 rounded-md border border-phosphor/30 bg-phosphor/5 text-xs">
            <span className="text-text-secondary">
              Showing hacks by <span className="text-phosphor font-medium">{author}</span>
            </span>
            <Link href={clearAuthorHref} className="ml-auto text-text-muted hover:text-phosphor underline shrink-0">
              Clear
            </Link>
          </div>
        )}
        {baseRomFilter && (
          <div className="flex items-center gap-2 flex-wrap px-3 py-2 rounded-md border border-phosphor/30 bg-phosphor/5 text-xs">
            <span className="text-text-secondary">
              Showing hacks that use <span className="text-phosphor font-medium">{baseRomFilter.name}</span>
              {baseRomFilter.fileExtension && <span className="text-text-muted font-mono"> (.{baseRomFilter.fileExtension})</span>}
              {' '}as their base ROM
            </span>
            <PlatformBadge platform={baseRomFilter.platform} size="sm" />
            <Link href={clearBaseRomHref} className="ml-auto text-text-muted hover:text-phosphor underline shrink-0">
              Clear
            </Link>
          </div>
        )}
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
                {sub.franchise && (
                  // `relative` lifts this above the card's full-cover link so it's
                  // independently clickable, same as the tag badges below.
                  <Link
                    href={`/submissions?franchise=${sub.franchise.id}`}
                    className="relative text-[10px] px-1.5 py-0.5 rounded border border-border text-text-secondary hover:text-phosphor hover:border-phosphor/40 transition-colors"
                  >
                    {sub.franchise.name}
                  </Link>
                )}
              </div>
              <p className="text-xs text-text-muted mt-0.5">
                {sub.author && (
                  <>
                    by{' '}
                    <Link href={`/submissions?author=${encodeURIComponent(sub.author)}`} className="relative hover:text-phosphor hover:underline">
                      {sub.author}
                    </Link>{' '}
                    ·{' '}
                  </>
                )}submitted {formatDistanceToNow(new Date(sub.createdAt), { addSuffix: true })} ·{' '}
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
              {sub.patchUploadedAt && (
                <span
                  className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-phosphor/10 text-phosphor"
                  title="A patch file has been uploaded for this submission"
                >
                  Patch
                </span>
              )}
              <ScoreGauge score={sub.verificationScore} />
              <StatusBadge status={sub.status} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
