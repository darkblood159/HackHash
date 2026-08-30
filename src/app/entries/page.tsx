// src/app/entries/page.tsx
import React from 'react';
import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { Download } from 'lucide-react';
import { PlatformBadge } from '@/components/ui/PlatformBadge';
import { TagBadge } from '@/components/ui/TagBadge';
import { PlatformFilters } from '@/components/PlatformFilters';
import { EntriesSearchBox } from '@/components/EntriesSearchBox';
import { PLATFORMS } from '@/types';
// Note: TagFilters is intentionally NOT on this page. Most entries come from
// DAT imports which don't assign tags to submissions — filtering the entries
// table by tag would almost always return nothing. Tag badges in the table
// link to /submissions?status=APPROVED&tag=... instead, which is where the
// tagged submissions actually live.

export const dynamic = 'force-dynamic';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export default async function EntriesPage({ searchParams }: { searchParams: { q?: string; page?: string; platform?: string } }) {
  const q = searchParams.q?.trim();
  const page = Math.max(1, parseInt(searchParams.page ?? '1'));
  const platform = searchParams.platform && (PLATFORMS as readonly string[]).includes(searchParams.platform)
    ? searchParams.platform
    : undefined;
  const perPage = 30;

  const where = {
    submission: { deletedAt: null },
    ...(q
      ? {
          OR: [
            { machineName: { contains: q, mode: 'insensitive' as const } },
            { sha1: { contains: q.toLowerCase(), mode: 'insensitive' as const } },
            { md5: { contains: q.toLowerCase(), mode: 'insensitive' as const } },
            { crc32: { contains: q.toLowerCase(), mode: 'insensitive' as const } },
          ],
        }
      : {}),
    ...(platform ? { platform: platform as any } : {}),
  };

  // Fetched unpaginated (but with a lean select) since grouping into
  // families has to happen before pagination can be applied — pagination
  // now needs to walk "distinct families", not raw rows. Fine at this
  // project's scale (see src/lib/hackFamily.ts's findDuplicateFamilyCandidates
  // for the same reasoning); would want a smarter query if this table ever
  // reaches tens of thousands of approved entries.
  const allMatching = await prisma.approvedEntry.findMany({
    where,
    select: {
      id: true,
      submissionId: true,
      machineName: true,
      platform: true,
      sha1: true,
      md5: true,
      crc32: true,
      fileSize: true,
      approvedAt: true,
      submission: {
        select: {
          hackName: true,
          author: true,
          releaseYear: true,
          releaseDate: true,
          hackFamilyId: true,
          hackFamily: { select: { name: true } },
          tags: { select: { tag: true } },
        },
      },
    },
    orderBy: { machineName: 'asc' },
  });

  type EntryRow = (typeof allMatching)[number];

  // A hash-lookup query should surface the SPECIFIC version that was
  // searched for as the representative, not just whichever version happens
  // to be newest — searching by hash is about finding one exact file.
  const isHashQuery = !!q && /^[0-9a-f]{6,40}$/i.test(q);
  function pickRepresentative(members: EntryRow[]): EntryRow {
    if (isHashQuery && q) {
      const qLower = q.toLowerCase();
      const hashMatch = members.find((m) => m.sha1.includes(qLower) || m.md5.includes(qLower) || m.crc32.includes(qLower));
      if (hashMatch) return hashMatch;
    }
    return [...members].sort((a, b) => new Date(b.approvedAt).getTime() - new Date(a.approvedAt).getTime())[0];
  }

  const byFamily = new Map<string, EntryRow[]>();
  for (const e of allMatching) {
    // Entries not yet grouped into a family (shouldn't happen once the
    // backfill's been run, but fall back to a "family of one" keyed on the
    // entry's own id so nothing silently disappears from the list).
    const key = e.submission.hackFamilyId ?? `single:${e.id}`;
    const list = byFamily.get(key) ?? [];
    list.push(e);
    byFamily.set(key, list);
  }

  const grouped = Array.from(byFamily.values()).map((members) => {
    const representative = pickRepresentative(members);
    return {
      representative,
      versionCount: members.length,
      displayName: representative.submission.hackFamily?.name ?? representative.submission.hackName,
    };
  });
  grouped.sort((a, b) => a.displayName.localeCompare(b.displayName));

  const total = grouped.length;
  const totalPages = Math.ceil(total / perPage);
  const entries = grouped.slice((page - 1) * perPage, page * perPage);

  const buildPageLink = (p: number) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (platform) params.set('platform', platform);
    params.set('page', String(p));
    return `/entries?${params.toString()}`;
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-12">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
        <div>
          <span className="text-phosphor text-xs font-mono uppercase tracking-widest">Master DAT</span>
          <h1 className="font-display text-3xl font-bold mt-2">Database</h1>
          <p className="text-text-secondary text-sm mt-1">
            {total.toLocaleString()} hack{total === 1 ? '' : 's'}
            {allMatching.length !== total && <> — {allMatching.length.toLocaleString()} approved versions total</>}
          </p>
        </div>
        <Link
          href="/entries/export"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-border text-text-primary text-sm hover:border-phosphor/50 hover:text-phosphor transition-colors shrink-0"
        >
          <Download size={14} /> Export DAT
        </Link>
      </div>

      <div className="mb-6">
        <PlatformFilters current={platform} />
      </div>

      <EntriesSearchBox initialQuery={q} platform={platform} />

      {entries.length === 0 && (
        <div className="text-center py-20 border border-dashed border-border rounded-xl text-text-muted">
          {q ? `No entries match "${q}".` : 'No approved entries yet.'}
        </div>
      )}

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-elevated text-text-muted text-xs uppercase tracking-wider">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Name</th>
              <th className="text-left px-4 py-3 font-medium">Platform</th>
              <th className="text-left px-4 py-3 font-medium hidden sm:table-cell">Author</th>
              <th className="text-left px-4 py-3 font-medium hidden lg:table-cell">Tags</th>
              <th className="text-left px-4 py-3 font-medium hidden md:table-cell">Size</th>
              <th className="text-left px-4 py-3 font-medium font-mono">SHA1</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(({ representative: entry, versionCount, displayName }) => (
              <tr key={entry.id} className="border-t border-border-subtle hover:bg-bg-elevated transition-colors">
                <td className="px-4 py-3">
                  <Link href={`/submissions/${entry.submissionId}`} className="text-text-primary hover:text-phosphor font-medium">
                    {displayName}
                  </Link>
                  {versionCount > 1 && (
                    <span className="ml-2 text-[10px] text-text-muted uppercase tracking-wider px-1.5 py-0.5 rounded bg-bg-elevated align-middle">
                      {versionCount} versions
                    </span>
                  )}
                </td>
                <td className="px-4 py-3"><PlatformBadge platform={entry.platform} size="sm" /></td>
                <td className="px-4 py-3 text-text-muted hidden sm:table-cell">{entry.submission.author ?? '—'}</td>
                <td className="px-4 py-3 hidden lg:table-cell">
                  <div className="flex gap-1 flex-wrap">
                    {entry.submission.tags.slice(0, 3).map(({ tag: t }) => (
                      <TagBadge key={t.id} name={t.name} slug={t.slug} href={`/submissions?status=APPROVED&tag=${t.slug}`} description={t.description} />
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3 text-text-muted hidden md:table-cell font-numeric">{formatBytes(Number(entry.fileSize))}</td>
                <td className="px-4 py-3 font-mono text-xs text-text-muted">{entry.sha1.slice(0, 16)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
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
