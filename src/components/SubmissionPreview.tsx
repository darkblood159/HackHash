'use client';

// src/components/SubmissionPreview.tsx
//
// Shared "preview before you save/propose" overlay for the two places a
// submission's fields get edited from its own detail page — AdminEditPanel
// (direct, applies immediately) and ChangeRequestSection (proposed,
// applies once an admin approves it). Neither commits anything; this just
// renders the SAME visual pieces submissions/[id]/page.tsx itself uses
// (PlatformBadge/TagBadge/StatusBadge/ScoreGauge/MappingsDisplay/
// ReleaseDate), in the same page-width layout with the same card classes,
// against the caller's current in-progress form state — a full page, not
// a condensed set of cards in a small dialog.
//
// SECOND ROUND (rewrite): originally a small Modal.tsx dialog holding a
// handful of condensed cards. Two things changed after actually using it:
// (1) it looked noticeably sparser than the real page because several
// always-visible, non-editable sections (File metadata, the score gauge)
// were left out entirely on the assumption that "not editable" meant "not
// needed in a preview" — wrong assumption, they're real content on the
// page and their absence is exactly what made the preview feel incomplete
// by comparison; (2) asked directly for a full page-style preview rather
// than a card dialog, AND for changed fields to be visually highlighted.
// Both addressed here: full-page overlay (own scrollable full-viewport
// container, not the small Modal component) mirroring page.tsx's own
// layout classes directly, and a `current` vs `proposed` field bag so
// every rendered piece can flag whether it differs from what's on record.
//
// Deliberately still NOT a side-by-side before/after diff — the ask was a
// full mock-up with changes highlighted IN PLACE, not two documents to
// compare. Deliberately still doesn't attempt sections neither edit form
// can affect at all regardless of fidelity (verifications' vote history,
// comments, audit trail, the patch FILE's own upload/apply UI, alternate
// formats, sibling-version switching, Hasheous sync-job status) — adding
// those would need data these forms have no reason to receive and would
// still just be set dressing around, not a preview of, an edit.
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { Eye, X } from 'lucide-react';
import { PlatformBadge } from './ui/PlatformBadge';
import { TagBadge } from './ui/TagBadge';
import { StatusBadge } from './ui/StatusBadge';
import { ScoreGauge } from './ui/ScoreGauge';
import { MappingsDisplay } from './MappingsDisplay';
import ReleaseDate from './ReleaseDate';
import { ALL_TAGS } from '@/lib/tags';
import { languageName } from '@/lib/languages';
import { ExternalLink, FileText, Github } from 'lucide-react';
import type { MappingValues } from './MappingsSection';
import type { SelectedBaseRom } from './BaseRomPicker';
import type { SelectedFamily } from './FamilyPicker';

export interface SubmissionPreviewFields {
  hackName: string;
  version: string;
  platform: string;
  author: string | null;
  releaseYear: number | null;
  releaseDate: string | null; // 'YYYY-MM-DD'
  description: string | null;
  versionChangelog: string | null;
  notes: string | null;
  releasePageUrl: string | null;
  githubUrl: string | null;
  sourceUrl: string | null;
  patchType: string | null;
  patchFilename: string | null;
  patchSha1: string | null;
  tags: string[]; // slugs
  translationLanguages: string[]; // codes
  mapping: MappingValues;
  baseRom: SelectedBaseRom | null;
  family: SelectedFamily | null;
}

export interface SubmissionPreviewData {
  // None of these three change through either edit form — passed through
  // once, never diffed against anything.
  status: string;
  verificationScore: number;
  fileInfo: {
    filename: string;
    // Pre-formatted (e.g. '2.14 MB'), not the raw BigInt Prisma stores
    // this as — BigInt isn't serializable across the Server->Client
    // Component boundary, so the caller formats it (same formatBytes()
    // the real page already uses) before it ever gets here.
    fileSize: string;
    crc32: string;
    md5: string;
    sha1: string;
  };
  current: SubmissionPreviewFields;
  proposed: SubmissionPreviewFields;
}

function neq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

function hasAnyMappingValue(m: MappingValues | null | undefined): boolean {
  return Object.values(m ?? {}).some((v) => !!v);
}

// Inline highlight for a short piece of changed text/badge — a ring +
// tinted background in `highlight`, this project's own dedicated
// call-attention color (tailwind.config.ts, picked in section 2ba
// specifically because it collides with nothing else in the status/phosphor
// palette — exactly the "make this one thing stand out" job it's for here).
function Diff({ changed, children }: { changed: boolean; children: React.ReactNode }) {
  if (!changed) return <>{children}</>;
  return <span className="rounded px-1 -mx-1 py-0.5 ring-1 ring-highlight/50 bg-highlight/10">{children}</span>;
}

// Same idea, block-level (left accent bar) for multi-line text — a ring
// around a whole paragraph reads oddly, a changed-bar down the side reads
// the way tracked-change margins usually do.
function DiffBlock({ changed, children }: { changed: boolean; children: React.ReactNode }) {
  if (!changed) return <>{children}</>;
  return <div className="rounded-r border-l-2 border-highlight bg-highlight/5 pl-3 py-1 -ml-3">{children}</div>;
}

function Row({ label, value, changed }: { label: string; value: string; changed?: boolean }) {
  return (
    <div
      className={clsx(
        'flex items-center justify-between py-2 px-2 -mx-2 rounded border-b border-border-subtle last:border-0',
        changed && 'bg-highlight/10 ring-1 ring-highlight/40 border-b-0'
      )}
    >
      <span className="text-xs text-text-muted font-mono uppercase tracking-wider">{label}</span>
      <span className="font-mono text-sm text-phosphor truncate max-w-[65%] text-right">{value}</span>
    </div>
  );
}

export function SubmissionPreviewOverlay({
  open,
  onClose,
  data,
}: {
  open: boolean;
  onClose: () => void;
  data: SubmissionPreviewData;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  const c = data.current;
  const p = data.proposed;

  const nameChanged = neq(c.hackName, p.hackName);
  const versionChanged = neq(c.version, p.version);
  const platformChanged = neq(c.platform, p.platform);
  const authorChanged = neq(c.author, p.author);
  const releaseChanged = neq(c.releaseYear, p.releaseYear) || neq(c.releaseDate, p.releaseDate);
  const descriptionChanged = neq(c.description, p.description);
  const notesChanged = neq(c.notes, p.notes);
  const changelogChanged = neq(c.versionChangelog, p.versionChangelog);
  const sourceChanged = neq(c.sourceUrl, p.sourceUrl);
  const releasePageChanged = neq(c.releasePageUrl, p.releasePageUrl);
  const githubChanged = neq(c.githubUrl, p.githubUrl);
  const patchTypeChanged = neq(c.patchType, p.patchType);
  const patchFilenameChanged = neq(c.patchFilename, p.patchFilename);
  const patchSha1Changed = neq(c.patchSha1, p.patchSha1);
  const mappingChanged = neq(c.mapping, p.mapping);
  const baseRomChanged = neq(c.baseRom?.id ?? null, p.baseRom?.id ?? null);
  const familyChanged = neq(c.family?.id ?? null, p.family?.id ?? null);

  const tagRows: { slug: string; state: 'unchanged' | 'added' | 'removed' }[] = [
    ...p.tags.map((slug) => ({ slug, state: c.tags.includes(slug) ? ('unchanged' as const) : ('added' as const) })),
    ...c.tags.filter((slug) => !p.tags.includes(slug)).map((slug) => ({ slug, state: 'removed' as const })),
  ];
  const langRows: { code: string; state: 'unchanged' | 'added' | 'removed' }[] = [
    ...p.translationLanguages.map((code) => ({
      code,
      state: c.translationLanguages.includes(code) ? ('unchanged' as const) : ('added' as const),
    })),
    ...c.translationLanguages.filter((code) => !p.translationLanguages.includes(code)).map((code) => ({ code, state: 'removed' as const })),
  ];

  const hasPatchInfo = !!(p.patchType || p.patchFilename || p.patchSha1);
  const showMapping = hasAnyMappingValue(p.mapping) || hasAnyMappingValue(c.mapping);
  const hasLinks = !!(p.sourceUrl || p.releasePageUrl || p.githubUrl || c.sourceUrl || c.releasePageUrl || c.githubUrl);

  return createPortal(
    <div className="fixed inset-0 z-50 bg-bg-base overflow-y-auto">
      <div className="sticky top-0 z-10 border-b border-border bg-bg-surface/95 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <Eye size={14} className="text-highlight shrink-0" />
            <span className="text-sm font-medium text-text-primary">Preview</span>
            <span className="text-xs text-text-muted">— nothing saved yet</span>
            <span className="flex items-center gap-1.5 text-xs text-text-muted ml-2">
              <span className="w-2.5 h-2.5 rounded-sm ring-1 ring-highlight/50 bg-highlight/10 inline-block shrink-0" />
              highlighted = changed
            </span>
          </div>
          <button
            onClick={onClose}
            className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary rounded px-2 py-1 hover:bg-bg-elevated"
          >
            <X size={14} /> Close preview
          </button>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12">
        {/* Header — mirrors submissions/[id]/page.tsx's own header block */}
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-8">
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="font-display text-3xl font-bold">
                <Diff changed={nameChanged}>{p.hackName || <em className="text-text-muted not-italic">Untitled</em>}</Diff>
              </h1>
              <span className="text-text-muted text-lg">
                <Diff changed={versionChanged}>v{p.version}</Diff>
              </span>
            </div>
            {p.author || p.releaseYear || p.releaseDate ? (
              <p className="text-text-secondary mt-1">
                {p.author && <Diff changed={authorChanged}>by {p.author}</Diff>}
                {p.author && (p.releaseYear || p.releaseDate) && ' · '}
                <Diff changed={releaseChanged}>
                  <ReleaseDate releaseDate={p.releaseDate} releaseYear={p.releaseYear} />
                </Diff>
              </p>
            ) : (
              <p className="text-text-muted mt-1 italic">
                <Diff changed={authorChanged || releaseChanged}>Author and release date not specified</Diff>
              </p>
            )}
            <div className="flex items-center gap-1.5 mt-3 flex-wrap">
              <Diff changed={platformChanged}>
                <PlatformBadge platform={p.platform} />
              </Diff>
              {tagRows.map(({ slug, state }) => {
                const def = ALL_TAGS.find((t) => t.slug === slug);
                if (!def) return null;
                if (state === 'removed') {
                  return (
                    <span
                      key={`removed-${slug}`}
                      className="inline-flex items-center rounded-full border border-status-rejected/30 px-2.5 py-0.5 text-[10px] font-medium text-status-rejected/70 line-through"
                    >
                      {def.name}
                    </span>
                  );
                }
                return (
                  <span
                    key={slug}
                    className={clsx(state === 'added' && 'rounded-full ring-1 ring-highlight/60 bg-highlight/10')}
                  >
                    <TagBadge name={def.name} slug={def.slug} description={def.description} />
                  </span>
                );
              })}
            </div>
            {langRows.length > 0 && (
              <p className="text-xs text-text-muted mt-2">
                Translated into:{' '}
                {langRows.map(({ code, state }, i) => (
                  <React.Fragment key={code}>
                    {i > 0 && ', '}
                    <span
                      className={clsx(
                        state === 'added' && 'rounded px-0.5 ring-1 ring-highlight/50 bg-highlight/10 text-text-primary',
                        state === 'removed' && 'line-through text-status-rejected/70'
                      )}
                    >
                      {languageName(code)}
                    </span>
                  </React.Fragment>
                ))}
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            <StatusBadge status={data.status} />
            <ScoreGauge score={data.verificationScore} />
          </div>
        </div>

        {p.versionChangelog && (
          <div className="mb-6 rounded-lg border border-phosphor/30 bg-phosphor/5 px-5 py-4">
            <h2 className="text-sm font-semibold text-phosphor mb-1">What's new in v{p.version || '?'}</h2>
            <DiffBlock changed={changelogChanged}>
              <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">{p.versionChangelog}</p>
            </DiffBlock>
          </div>
        )}

        <div className="grid lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
            {/* Description */}
            <div className="p-5 rounded-lg border border-border bg-bg-surface">
              <h2 className="text-sm font-semibold text-text-primary mb-2">Description</h2>
              <DiffBlock changed={descriptionChanged}>
                {p.description ? (
                  <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">{p.description}</p>
                ) : (
                  <p className="text-sm text-text-muted italic">No description provided.</p>
                )}
              </DiffBlock>
              {p.notes && (
                <>
                  <h3 className="text-sm font-semibold text-text-primary mt-4 mb-2">Notes</h3>
                  <DiffBlock changed={notesChanged}>
                    <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">{p.notes}</p>
                  </DiffBlock>
                </>
              )}
              {hasLinks && (
                <div className="flex flex-wrap gap-4 mt-4 pt-4 border-t border-border-subtle">
                  {p.sourceUrl && (
                    <Diff changed={sourceChanged}>
                      <a href={p.sourceUrl} target="_blank" rel="noreferrer" className="text-xs text-phosphor flex items-center gap-1 hover:underline">
                        <ExternalLink size={12} /> Source
                      </a>
                    </Diff>
                  )}
                  {!p.sourceUrl && c.sourceUrl && (
                    <span className="text-xs text-status-rejected/70 line-through flex items-center gap-1">
                      <ExternalLink size={12} /> Source
                    </span>
                  )}
                  {p.releasePageUrl && (
                    <Diff changed={releasePageChanged}>
                      <a href={p.releasePageUrl} target="_blank" rel="noreferrer" className="text-xs text-phosphor flex items-center gap-1 hover:underline">
                        <FileText size={12} /> Release page
                      </a>
                    </Diff>
                  )}
                  {!p.releasePageUrl && c.releasePageUrl && (
                    <span className="text-xs text-status-rejected/70 line-through flex items-center gap-1">
                      <FileText size={12} /> Release page
                    </span>
                  )}
                  {p.githubUrl && (
                    <Diff changed={githubChanged}>
                      <a href={p.githubUrl} target="_blank" rel="noreferrer" className="text-xs text-phosphor flex items-center gap-1 hover:underline">
                        <Github size={12} /> GitHub
                      </a>
                    </Diff>
                  )}
                  {!p.githubUrl && c.githubUrl && (
                    <span className="text-xs text-status-rejected/70 line-through flex items-center gap-1">
                      <Github size={12} /> GitHub
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* File metadata — never edited by either form, shown as-is */}
            <div className="p-5 rounded-lg border border-border bg-bg-surface">
              <h2 className="text-sm font-semibold text-text-primary mb-3">File metadata</h2>
              <div>
                <Row label="Filename" value={data.fileInfo.filename} />
                <Row label="Size" value={data.fileInfo.fileSize} />
                <Row label="CRC32" value={data.fileInfo.crc32} />
                <Row label="MD5" value={data.fileInfo.md5} />
                <Row label="SHA1" value={data.fileInfo.sha1} />
              </div>
            </div>

            {hasPatchInfo && (
              <div className="p-5 rounded-lg border border-border bg-bg-surface">
                <h2 className="text-sm font-semibold text-text-primary mb-3">Patch file</h2>
                <div>
                  {p.patchType && <Row label="Type" value={p.patchType} changed={patchTypeChanged} />}
                  {p.patchFilename && <Row label="Filename" value={p.patchFilename} changed={patchFilenameChanged} />}
                  {p.patchSha1 && <Row label="SHA1" value={p.patchSha1} changed={patchSha1Changed} />}
                </div>
              </div>
            )}

            {showMapping && (
              <div
                className={clsx(
                  mappingChanged && 'rounded-lg ring-1 ring-highlight/40 bg-highlight/5 p-1'
                )}
              >
                {hasAnyMappingValue(p.mapping) ? (
                  <MappingsDisplay mapping={p.mapping} hackName={p.hackName} />
                ) : (
                  <div className="p-5 rounded-lg border border-border bg-bg-surface">
                    <h2 className="text-sm font-semibold text-text-primary mb-1">Game database links</h2>
                    <p className="text-sm text-status-rejected/70 line-through">Previously linked — would be removed</p>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="space-y-6">
            {p.baseRom && (
              <div
                className={clsx(
                  'p-5 rounded-lg border bg-bg-surface',
                  baseRomChanged ? 'border-highlight/50 ring-1 ring-highlight/40' : 'border-border'
                )}
              >
                <h2 className="text-sm font-semibold text-text-primary mb-1">Base ROM required</h2>
                <p className="text-sm text-text-secondary">
                  {p.baseRom.name}
                  {p.baseRom.fileExtension && <span className="text-text-muted"> (.{p.baseRom.fileExtension})</span>}
                </p>
              </div>
            )}
            {!p.baseRom && c.baseRom && (
              <div className="p-5 rounded-lg border border-highlight/50 ring-1 ring-highlight/40 bg-bg-surface">
                <h2 className="text-sm font-semibold text-text-primary mb-1">Base ROM required</h2>
                <p className="text-sm text-status-rejected/70 line-through">{c.baseRom.name} — would be removed</p>
              </div>
            )}

            {p.family && (
              // Not its own card on the real page — family isn't shown as
              // a distinct block there, it drives the version switcher and
              // shared-field sync instead — so a plain note, not a full
              // mimicked card, is the accurate preview here.
              <p className={clsx('text-xs text-text-muted', familyChanged && 'rounded px-1 -mx-1 ring-1 ring-highlight/50 bg-highlight/10 inline-block')}>
                Would be grouped under the <span className="text-text-primary">{p.family.name}</span> family.
              </p>
            )}
            {!p.family && c.family && (
              <p className="text-xs text-status-rejected/70 line-through">
                Would leave the "{c.family.name}" family.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
