// src/app/submissions/[id]/page.tsx
import React from 'react';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { PlatformBadge } from '@/components/ui/PlatformBadge';
import { TagBadge } from '@/components/ui/TagBadge';
import { ScoreGauge } from '@/components/ui/ScoreGauge';
import { TrustBadge } from '@/components/ui/TrustBadge';
import { Avatar } from '@/components/ui/Avatar';
import { formatDistanceToNow, format } from 'date-fns';
import { ExternalLink, Github, FileText, ChevronDown, Search } from 'lucide-react';
import Link from 'next/link';
import { VerifyPanel } from '@/components/VerifyPanel';
import { AdminActions } from '@/components/AdminActions';
import { AdminEditPanel } from '@/components/AdminEditPanel';
import { CommentSection } from '@/components/CommentSection';
import { ChangeRequestSection } from '@/components/ChangeRequestSection';
import { PatchFileUpload } from '@/components/PatchFileUpload';
import { PatchApplyButton } from '@/components/PatchApplyButton';
import { canManagePatchFile } from '@/lib/patchPermissions';
import { arePatchUploadsDisabled } from '@/lib/siteSettings';
import { MappingsDisplay } from '@/components/MappingsDisplay';
import { languageName } from '@/lib/languages';
import { ForceRepullButton } from '@/components/ForceRepullButton';
import { HasheousSyncBadge } from '@/components/HasheousSyncBadge';
import { DuplicateReportButton } from '@/components/DuplicateReportButton';
import { RestoreSubmissionButton } from '@/components/RestoreSubmissionButton';
import { AlternateFormats } from '@/components/AlternateFormats';
import ReleaseDate from '@/components/ReleaseDate';
import { toISODateOnly } from '@/lib/hackFamily';

export const dynamic = 'force-dynamic';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function HashRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border-subtle last:border-0">
      <span className="text-xs text-text-muted font-mono uppercase tracking-wider">{label}</span>
      <span className="font-mono text-sm text-phosphor">{value}</span>
    </div>
  );
}

export default async function SubmissionDetailPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);

  const submission = await prisma.submission.findUnique({
    where: { id: params.id },
    include: {
      submittedBy: { select: { id: true, name: true, image: true, username: true, trustScore: true, role: true } },
      verifications: {
        include: { user: { select: { id: true, name: true, image: true, username: true, trustScore: true, role: true } } },
        orderBy: { createdAt: 'desc' },
      },
      tags: { include: { tag: true } },
      comments: {
        where: { isDeleted: false },
        include: { user: { select: { id: true, name: true, image: true, username: true, role: true } } },
        orderBy: { createdAt: 'asc' },
      },
      auditLogs: {
        include: { user: { select: { id: true, name: true, username: true } } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      },
      duplicateReports: {
        include: { user: { select: { id: true, name: true, username: true } }, original: { select: { id: true, hackName: true } } },
      },
      approvedEntry: true,
      gameMapping: true,
      baseRom: true,
      hackFamily: { select: { id: true, name: true } },
      alternateFormats: {
        orderBy: { createdAt: 'asc' },
        include: {
          addedBy: { select: { id: true, name: true, username: true } },
          reviewedBy: { select: { id: true, name: true, username: true } },
        },
      },
      changeRequests: {
        include: {
          requestedBy: { select: { id: true, name: true, image: true } },
          reviewedBy: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!submission) notFound();

  // This page queries Prisma directly rather than going through the GET API
  // route above, and was missing the same deletedAt gate that route already
  // has — meaning a soft-deleted submission's detail page was reachable by
  // anyone with the URL, not just admins. Matches the project's existing
  // "public detail page 404s for non-admins" requirement; fixing it here
  // since it's the exact same pattern already used elsewhere.
  if (submission.deletedAt && session?.user?.role !== 'ADMINISTRATOR') notFound();

  // Other versions of this same hack, for the version switcher below.
  const siblingVersions = submission.hackFamilyId
    ? await prisma.submission.findMany({
        where: { hackFamilyId: submission.hackFamilyId, id: { not: submission.id }, deletedAt: null },
        select: { id: true, version: true, status: true, createdAt: true },
      })
    : [];

  // How many OTHER live submissions point at the same base rom, if any —
  // powers the "find other hacks using this base ROM" link in the Base ROM
  // card below. A plain count (Submission.baseRomId is already indexed)
  // rather than fetching full rows, since this page only needs the number;
  // the actual list is what /submissions?baseRomId=... is for.
  const baseRomUsageCount = submission.baseRomId
    ? await prisma.submission.count({
        where: { baseRomId: submission.baseRomId, id: { not: submission.id }, deletedAt: null },
      })
    : 0;

  const userVerification = session?.user
    ? submission.verifications.find((v) => v.user.id === session.user.id)
    : null;

  const isOwner = session?.user?.id === submission.submittedBy.id;
  const isAdmin = session?.user?.role === 'ADMINISTRATOR';
  const canVerify = session?.user && !isOwner && !userVerification && !['APPROVED', 'REJECTED'].includes(submission.status);
  const canManagePatch = canManagePatchFile({
    viewerId: session?.user?.id,
    viewerRole: session?.user?.role,
    submittedById: submission.submittedBy.id,
    status: submission.status,
    patchUploadedAt: submission.patchUploadedAt,
  });
  // Admin kill switch (src/lib/siteSettings.ts) — only hides the
  // upload/replace dropzone below; deliberately does not affect
  // canDownloadPatch/canPatchInBrowser just below, which is the whole
  // point of keeping "uploading" and "the patching" as two separate
  // things a person can pause independently of each other.
  const uploadsDisabled = await arePatchUploadsDisabled();
  // Mirrors GET /api/submissions/[id]/patch's own gate exactly — shown
  // here only when it would actually succeed, rather than letting someone
  // go through the whole "drop your ROM" flow just to hit a 403 at the
  // very last step.
  const canDownloadPatch =
    submission.status === 'APPROVED' || isOwner || isAdmin || session?.user?.role === 'VERIFIER';
  // Single shared condition for "the in-browser patch flow actually
  // applies here" — used both by the header CTA below and by the section
  // itself further down, so the two can't drift out of sync with each
  // other about when to show up.
  const canPatchInBrowser = !!(
    submission.patchUploadedAt &&
    submission.patchType &&
    submission.baseRom &&
    canDownloadPatch
  );

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12">
      {submission.deletedAt && isAdmin && (
        <div className="flex items-center justify-between gap-3 mb-6 p-3 rounded-lg border border-status-rejected/40 bg-status-rejected-bg">
          <p className="text-xs text-status-rejected">
            This submission is deleted — hidden from everyone but administrators.
          </p>
          <RestoreSubmissionButton submissionId={submission.id} />
        </div>
      )}
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-8">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="font-display text-3xl font-bold">{submission.hackName}</h1>
            <span className="text-text-muted text-lg">v{submission.version}</span>
          </div>
          {(submission.author || submission.releaseYear || submission.releaseDate) ? (
            <p className="text-text-secondary mt-1">
              {submission.author && <>by {submission.author}</>}
              {submission.author && (submission.releaseYear || submission.releaseDate) && ' · '}
              <ReleaseDate releaseDate={toISODateOnly(submission.releaseDate)} releaseYear={submission.releaseYear} />
            </p>
          ) : (
            <p className="text-text-muted mt-1 italic">Author and release date not specified</p>
          )}
          <div className="flex items-center gap-1.5 mt-3 flex-wrap">
            <PlatformBadge platform={submission.platform} />
            {submission.tags.map(({ tag }) => (
              <TagBadge
                key={tag.id}
                name={tag.name}
                slug={tag.slug}
                href={`/submissions?tag=${tag.slug}`}
                description={tag.description}
              />
            ))}
            <HasheousSyncBadge
              hasheousId={submission.gameMapping?.hasheousId}
              hasheousEnv={submission.gameMapping?.hasheousEnv}
              hasheousSyncedAt={submission.gameMapping?.hasheousSyncedAt}
            />
          </div>
          {submission.translationLanguages?.length > 0 && (
            <p className="text-xs text-text-muted mt-2">
              Translated into: {submission.translationLanguages.map(languageName).join(', ')}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <StatusBadge status={submission.status} />
          <ScoreGauge score={submission.verificationScore} />
          {canPatchInBrowser && (
            <PatchApplyButton
              submissionId={submission.id}
              patchType={submission.patchType!}
              baseRom={{ sha1: submission.baseRom!.sha1, name: submission.baseRom!.name }}
              expectedOutput={{ sha1: submission.sha1, filename: submission.filename }}
            />
          )}
        </div>
      </div>

      {siblingVersions.length > 0 && (
        <div className="flex items-center gap-2 mb-8 flex-wrap">
          <span className="text-xs text-text-muted uppercase tracking-wider">Versions:</span>
          {[
            { id: submission.id, version: submission.version, createdAt: submission.createdAt, current: true },
            ...siblingVersions.map((v) => ({ ...v, current: false })),
          ]
            .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
            .map((v) =>
              v.current ? (
                <span
                  key={v.id}
                  className="px-2.5 py-1 rounded-full text-xs font-medium bg-phosphor/15 border border-phosphor/40 text-phosphor"
                >
                  v{v.version}
                </span>
              ) : (
                <Link
                  key={v.id}
                  href={`/submissions/${v.id}`}
                  className="px-2.5 py-1 rounded-full text-xs font-medium border border-border text-text-muted hover:border-phosphor/30 hover:text-text-primary transition-colors"
                >
                  v{v.version}
                </Link>
              )
            )}
        </div>
      )}

      {submission.versionChangelog && (
        <details className="group mb-6 rounded-lg border border-phosphor/30 bg-phosphor/5">
          <summary className="px-5 py-4 cursor-pointer list-none flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-phosphor">What's new in v{submission.version}</h2>
            <ChevronDown size={18} className="text-phosphor shrink-0 group-open:rotate-180 transition-transform" />
          </summary>
          <p className="px-5 pb-5 text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">{submission.versionChangelog}</p>
        </details>
      )}

      <div className="grid lg:grid-cols-3 gap-8">
        {/* Main column */}
        <div className="lg:col-span-2 space-y-6">
          {/* Description */}
          <div className="p-5 rounded-lg border border-border bg-bg-surface">
            {submission.description ? (
              <>
                <h2 className="text-sm font-semibold text-text-primary mb-2">Description</h2>
                <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">{submission.description}</p>
              </>
            ) : (
              <p className="text-sm text-text-muted italic">No description provided.</p>
            )}

            {submission.notes && (
              <>
                <h3 className="text-sm font-semibold text-text-primary mt-4 mb-2">Notes</h3>
                <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">{submission.notes}</p>
              </>
            )}

            <div className="flex flex-wrap gap-4 mt-4 pt-4 border-t border-border-subtle">
              {submission.sourceUrl && (
                <a href={submission.sourceUrl} target="_blank" rel="noreferrer" className="text-xs text-phosphor flex items-center gap-1 hover:underline">
                  <ExternalLink size={12} /> Source
                </a>
              )}
              {submission.releasePageUrl && (
                <a href={submission.releasePageUrl} target="_blank" rel="noreferrer" className="text-xs text-phosphor flex items-center gap-1 hover:underline">
                  <FileText size={12} /> Release page
                </a>
              )}
              {submission.githubUrl && (
                <a href={submission.githubUrl} target="_blank" rel="noreferrer" className="text-xs text-phosphor flex items-center gap-1 hover:underline">
                  <Github size={12} /> GitHub
                </a>
              )}
            </div>
          </div>

          {/* Hash data */}
          <div className="p-5 rounded-lg border border-border bg-bg-surface">
            <h2 className="text-sm font-semibold text-text-primary mb-3">File metadata</h2>
            <div className="space-y-0">
              <HashRow label="Filename" value={submission.filename} />
              <HashRow label="Size" value={formatBytes(Number(submission.fileSize))} />
              <HashRow label="CRC32" value={submission.crc32} />
              <HashRow label="MD5" value={submission.md5} />
              <HashRow label="SHA1" value={submission.sha1} />
            </div>
          </div>

          {/* Patch file */}
          <div className="p-5 rounded-lg border border-border bg-bg-surface">
            <h2 className="text-sm font-semibold text-text-primary mb-3">Patch file</h2>
            {(submission.patchType || submission.patchFilename || submission.patchSha1) && (
              <div className="space-y-0 mb-3">
                {submission.patchType && <HashRow label="Type" value={submission.patchType} />}
                {submission.patchFilename && <HashRow label="Filename" value={submission.patchFilename} />}
                {submission.patchSha1 && <HashRow label="SHA1" value={submission.patchSha1} />}
                {submission.patchFileSize != null && (
                  <HashRow label="Size" value={formatBytes(Number(submission.patchFileSize))} />
                )}
                {submission.patchUploadedAt && (
                  <HashRow label="Uploaded" value={format(new Date(submission.patchUploadedAt), 'MMM d, yyyy')} />
                )}
              </div>
            )}
            <PatchFileUpload
              submissionId={submission.id}
              canManage={canManagePatch}
              hasFile={!!submission.patchUploadedAt}
              uploadsDisabled={uploadsDisabled}
            />
          </div>

          {/* Alternate formats */}
          {submission.status === 'APPROVED' && (
            <AlternateFormats
              submissionId={submission.id}
              formats={submission.alternateFormats.map((f) => ({
                ...f,
                fileSize: f.fileSize.toString(),
                createdAt: f.createdAt.toISOString(),
              }))}
              canAdd={!!session?.user && !session.user.isBanned}
              viewerId={session?.user?.id ?? null}
              viewerRole={session?.user?.role ?? 'GUEST'}
              viewerTrustScore={session?.user?.trustScore ?? 0}
            />
          )}

          {/* Base ROM */}
          {submission.baseRom && (
            <div className="p-5 rounded-lg border border-border bg-bg-surface">
              <h2 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
                Base ROM required
                {submission.baseRom.status === 'PENDING' && (
                  <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-status-pending-bg text-status-pending">
                    Pending review
                  </span>
                )}
                {submission.baseRom.status === 'REJECTED' && (
                  <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-status-rejected-bg text-status-rejected">
                    Rejected — verify independently
                  </span>
                )}
              </h2>
              <div className="space-y-0">
                <HashRow label="Name" value={submission.baseRom.name} />
                {submission.baseRom.fileExtension && (
                  <HashRow label="Format" value={`.${submission.baseRom.fileExtension}`} />
                )}
                <HashRow label="CRC32" value={submission.baseRom.crc32} />
                <HashRow label="MD5" value={submission.baseRom.md5} />
                <HashRow label="SHA1" value={submission.baseRom.sha1} />
              </div>
              {baseRomUsageCount > 0 ? (
                <Link
                  href={`/submissions?baseRomId=${submission.baseRom.id}`}
                  className="mt-3 pt-3 border-t border-border-subtle flex items-center gap-1.5 text-xs text-phosphor hover:underline"
                >
                  <Search size={12} />
                  Find {baseRomUsageCount} other hack{baseRomUsageCount === 1 ? '' : 's'} using this base ROM
                </Link>
              ) : (
                <p className="mt-3 pt-3 border-t border-border-subtle text-xs text-text-muted">
                  No other submissions reference this base ROM yet.
                </p>
              )}
            </div>
          )}

          {/* Verify panel */}
          {canVerify && (
            <VerifyPanel
              submissionId={submission.id}
              expectedHashes={{ crc32: submission.crc32, md5: submission.md5, sha1: submission.sha1 }}
              viewerTrustScore={session?.user?.trustScore ?? 0}
              viewerRole={session?.user?.role ?? 'GUEST'}
            />
          )}

          {userVerification && (
            <div className="p-4 rounded-lg border border-status-verified/30 bg-status-verified-bg text-sm text-status-verified">
              You verified this submission as {userVerification.matches ? 'matching' : 'not matching'} your copy.
            </div>
          )}

          {isOwner && (
            <div className="p-4 rounded-lg border border-border bg-bg-elevated text-sm text-text-muted">
              This is your submission — other contributors must verify it.
            </div>
          )}

          {/* Verifications list */}
          <div className="p-5 rounded-lg border border-border bg-bg-surface">
            <h2 className="text-sm font-semibold text-text-primary mb-3">
              Verifications ({submission.verifications.length})
            </h2>
            {submission.verifications.length === 0 && (
              <p className="text-sm text-text-muted">No verifications yet.</p>
            )}
            <div className="space-y-3">
              {submission.verifications.map((v) => (
                <div key={v.id} className="flex items-start gap-3">
                  <Avatar src={v.user.image} name={v.user.name} size={28} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link href={`/profile/${v.user.id}`} className="text-sm font-medium text-text-primary hover:text-phosphor">
                        {v.user.name}
                      </Link>
                      <TrustBadge score={v.user.trustScore} showWeight />
                      <span className={`text-xs px-1.5 py-0.5 rounded ${v.matches ? 'bg-status-approved-bg text-status-approved' : 'bg-status-rejected-bg text-status-rejected'}`}>
                        {v.matches ? 'Matches' : 'Does not match'}
                      </span>
                      {v.isManualVote && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-status-pending-bg text-status-pending">
                          Manual vote
                        </span>
                      )}
                    </div>
                    {v.notes && <p className="text-xs text-text-secondary mt-1">{v.notes}</p>}
                    <p className="text-xs text-text-muted mt-0.5">{formatDistanceToNow(new Date(v.createdAt), { addSuffix: true })}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Duplicate reports */}
          {submission.duplicateReports.length > 0 && (
            <div className="p-5 rounded-lg border border-status-disputed/30 bg-status-disputed-bg">
              <h2 className="text-sm font-semibold text-status-disputed mb-3">Duplicate reports</h2>
              <div className="space-y-2">
                {submission.duplicateReports.map((d) => (
                  <div key={d.id} className="text-sm text-text-secondary">
                    <span className="text-text-primary">{d.user.name}</span> flagged as{' '}
                    <span className="font-medium">{d.duplicateType.replace(/_/g, ' ').toLowerCase()}</span>
                    {d.original && (
                      <> — see <Link href={`/submissions/${d.original.id}`} className="text-phosphor hover:underline">{d.original.hackName}</Link></>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Comments */}
          <CommentSection submissionId={submission.id} comments={submission.comments as any} canComment={!!session?.user} isAdmin={isAdmin} />

          <ChangeRequestSection
            submissionId={submission.id}
            current={{
              hackName: submission.hackName,
              version: submission.version,
              versionChangelog: submission.versionChangelog,
              author: submission.author,
              releaseYear: submission.releaseYear,
              releaseDate: toISODateOnly(submission.releaseDate),
              platform: submission.platform,
              sourceUrl: submission.sourceUrl,
              description: submission.description,
              notes: submission.notes,
              releasePageUrl: submission.releasePageUrl,
              githubUrl: submission.githubUrl,
              patchType: submission.patchType,
              patchFilename: submission.patchFilename,
              patchSha1: submission.patchSha1,
            }}
            currentMapping={submission.gameMapping as any}
            currentFamily={submission.hackFamily}
            currentBaseRom={submission.baseRom ? { id: submission.baseRom.id, name: submission.baseRom.name, status: submission.baseRom.status, fileExtension: submission.baseRom.fileExtension } : null}
            currentTags={submission.tags.map((t: any) => t.tag.slug)}
            currentTranslationLanguages={submission.translationLanguages}
            initialRequests={submission.changeRequests as any}
            isAdmin={isAdmin}
            canRequest={!!session?.user && !session.user.isBanned}
            hasOtherVersions={siblingVersions.length > 0}
          />

          {/* Game database mappings — read-only */}
          {submission.gameMapping && (
            <MappingsDisplay mapping={submission.gameMapping as any} hackName={submission.hackName} />
          )}
          {isAdmin && submission.status === 'APPROVED' && (
            <ForceRepullButton submissionId={submission.id} />
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Submitter */}
          <div className="p-5 rounded-lg border border-border bg-bg-surface">
            <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Submitted by</h2>
            <Link href={`/profile/${submission.submittedBy.id}`} className="flex items-center gap-3 group">
              <Avatar src={submission.submittedBy.image} name={submission.submittedBy.name} size={40} />
              <div>
                <p className="text-sm font-medium text-text-primary group-hover:text-phosphor transition-colors">
                  {submission.submittedBy.name}
                </p>
                <TrustBadge score={submission.submittedBy.trustScore} />
              </div>
            </Link>
            <p className="text-xs text-text-muted mt-3">
              {formatDistanceToNow(new Date(submission.createdAt), { addSuffix: true })}
            </p>
          </div>

          {/* Admin actions */}
          {isAdmin && (
            <AdminActions
              submissionId={submission.id}
              status={submission.status}
              hackName={submission.hackName}
              version={submission.version}
              platform={submission.platform}
              currentFamily={submission.hackFamily}
              hasOtherVersions={siblingVersions.length > 0}
            />
          )}

          {isAdmin && (
            <AdminEditPanel
              submissionId={submission.id}
              status={submission.status}
              initial={{
                hackName: submission.hackName,
                version: submission.version,
                platform: submission.platform,
                author: submission.author,
                releaseYear: submission.releaseYear,
                releaseDate: toISODateOnly(submission.releaseDate),
                description: submission.description,
                versionChangelog: submission.versionChangelog,
                sourceUrl: submission.sourceUrl,
                translationLanguages: submission.translationLanguages,
              }}
              mapping={submission.gameMapping as any}
              tags={submission.tags.map((t: any) => t.tag.slug)}
              currentFamily={submission.hackFamily}
              currentBaseRom={submission.baseRom ? { id: submission.baseRom.id, name: submission.baseRom.name, status: submission.baseRom.status, fileExtension: submission.baseRom.fileExtension } : null}
              hasOtherVersions={siblingVersions.length > 0}
            />
          )}

          {/* Report duplicate */}
          {session?.user && !isOwner && (
            <DuplicateReportButton submissionId={submission.id} />
          )}

          {/* Approved entry */}
          {submission.approvedEntry && (
            <div className="p-5 rounded-lg border border-status-approved/30 bg-status-approved-bg">
              <h2 className="text-xs font-semibold text-status-approved uppercase tracking-wider mb-2">DAT entry</h2>
              <p className="font-mono text-xs text-text-primary break-all">{submission.approvedEntry.machineName}</p>
              {/[0-9a-f]{7}\]$/.test(submission.approvedEntry.machineName) && (
                <p className="text-xs text-text-muted mt-1.5">
                  The <span className="font-mono">[tag]</span> at the end disambiguates this file from another entry that would
                  otherwise share the exact same name — most likely a different base ROM or patching tool was used. It only
                  appears here and in the actual DAT file, never in the hack's name elsewhere on the site.
                </p>
              )}
              <p className="text-xs text-text-muted mt-2">
                Approved {format(new Date(submission.approvedEntry.approvedAt), 'MMM d, yyyy')}
              </p>
            </div>
          )}

          {/* Audit trail */}
          <div className="p-5 rounded-lg border border-border bg-bg-surface">
            <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Audit trail</h2>
            <div className="space-y-3">
              {submission.auditLogs.map((log) => (
                <div key={log.id} className="text-xs">
                  <p className="text-text-secondary">
                    <span className="text-text-primary font-medium">{log.action.replace(/_/g, ' ').toLowerCase()}</span>
                    {log.user && <> by {log.user.name}</>}
                  </p>
                  <p className="text-text-muted">{formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
