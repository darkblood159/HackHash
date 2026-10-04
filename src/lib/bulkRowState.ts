// src/lib/bulkRowState.ts
//
// The data shapes of the bulk-submit table, plus the pure functions that turn
// them into (a) what's wrong with a row, (b) the order rows are created in,
// and (c) the exact JSON sent to POST /api/submissions. No React, no network,
// so each can be tested on its own — in particular buildCreatePayload is
// checked against the REAL createSubmissionSchema (the server's own
// definition of a valid submission), which is what stops this form and the
// server drifting apart.

import type { PatchTypeValue } from './patchTypes';
import type { MappingValues } from '@/components/MappingsSection';
import type { PatchVerification } from './bulkVerify';
import type { PairConfidence } from './bulkPairing';
import type { RowCheckResult } from './bulkChecks';
import { MAPPING_FIELD_KEYS } from './mappingFields';
import { TRANSLATION_TRIGGER_SLUGS } from './tags';
import { versionCompare, nameResembles, hackNameFromFilename } from './bulkPairing';

export type RowPhase = 'hashing' | 'ready' | 'sending' | 'created' | 'failed';
export type PatchPhase = 'idle' | 'uploading' | 'uploaded' | 'failed' | 'skipped';

export interface PatchEntry {
  key: string;
  file: File;
  filename: string;
  patchType: PatchTypeValue | null;
  /** null until hashed. */
  sha1: string | null;
  error: string | null;
}

export interface BulkRow {
  key: string;
  file: File;
  filename: string;
  fileSize: number;
  hash: { crc32: string; md5: string; sha1: string } | null;
  hashProgress: number;
  hashError: string | null;
  version: string;
  /** True while `version` is still exactly what was guessed from the filename. */
  versionAuto: boolean;
  releaseDate: string;
  changelog: string;
  /** Empty = use the batch's default source URL. */
  sourceUrl: string;
  patchKey: string | null;
  /** How the current pairing was made; 'manual' = the person chose it. */
  patchConfidence: PairConfidence | 'manual' | null;
  verify: PatchVerification | 'running' | null;
  phase: RowPhase;
  error: string | null;
  submissionId: string | null;
  patchPhase: PatchPhase;
  patchError: string | null;
  /** Signature of the warnings the person has acknowledged (see warningSignature). */
  ackedWarnings: string;
}

export interface BulkHeader {
  hackName: string;
  platform: string;
  description: string;
  sourceUrl: string;
  releasePageUrl: string;
  githubUrl: string;
  tags: string[];
  translationLanguages: string[];
  mappings: MappingValues;
  baseRomId: string | null;
  authorId: string | null;
  /** Only while nothing was picked from the Author list — same rule as the single form. */
  legacyAuthor: string | null;
  franchiseId: string | null;
}

export interface RowIssues {
  /** Block sending. */
  errors: string[];
  /** Need a tick before sending. `id` makes the acknowledgement stable. */
  warnings: Array<{ id: string; text: string; href?: string }>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Same bounds createSubmissionSchema.releaseDate enforces, and slightly
 * stricter on purpose: the schema's check (`new Date(...)` is not NaN) lets
 * an impossible date like 2021-02-31 through, because JavaScript rolls it
 * over to March 3rd — so the server would accept it and store a different
 * date than was typed. The round-trip comparison below refuses it. (A
 * browser date input can't produce one; this only matters for values that
 * got here some other way.)
 */
export function isValidReleaseDate(value: string, nowYear: number): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  if (isNaN(d.getTime())) return false;
  if (d.toISOString().slice(0, 10) !== value) return false;
  const y = d.getUTCFullYear();
  return y >= 1990 && y <= nowYear + 1;
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function effectiveSourceUrl(row: BulkRow, header: Pick<BulkHeader, 'sourceUrl'>): string {
  return (row.sourceUrl || header.sourceUrl).trim();
}

export interface IssueContext {
  header: Pick<BulkHeader, 'hackName' | 'sourceUrl'>;
  /** The server's dry-run result for this row, if the check has come back. */
  check: RowCheckResult | undefined;
  /** True when this row's release date is earlier than a lower version's (dateOrderIssues). */
  dateOutOfOrder: boolean;
  nowYear: number;
}

export function computeRowIssues(row: BulkRow, ctx: IssueContext): RowIssues {
  const errors: string[] = [];
  const warnings: RowIssues['warnings'] = [];

  if (row.hashError) errors.push(row.hashError);
  else if (!row.hash) errors.push('Still reading this file…');

  const version = row.version.trim();
  if (!version) errors.push('Needs a version label.');
  else if (version.length > 50) errors.push('Version label is too long (50 characters at most).');

  const url = effectiveSourceUrl(row, ctx.header);
  if (!url) errors.push('Needs a source URL — set a default above, or one for this version.');
  else if (!isHttpUrl(url)) errors.push('The source URL isn\'t a valid web address.');

  if (row.releaseDate && !isValidReleaseDate(row.releaseDate, ctx.nowYear)) {
    errors.push(`Release date must be a real date between 1990 and ${ctx.nowYear + 1}.`);
  }
  if (row.changelog.length > 3000) errors.push('Changelog is too long (3000 characters at most).');

  for (const e of ctx.check?.errors ?? []) errors.push(e.message);
  for (const w of ctx.check?.warnings ?? []) warnings.push({ id: w.code, text: w.message, href: w.href });

  if (!nameResembles(hackNameFromFilename(row.filename), ctx.header.hackName)) {
    warnings.push({ id: 'NAME_MISMATCH', text: "This file's name doesn't look like the hack above — make sure it belongs here." });
  }
  if (ctx.dateOutOfOrder) {
    warnings.push({ id: 'DATE_ORDER', text: 'Dated earlier than a lower version — check the release dates.' });
  }

  // Patch pairing. 'verified' means the patch demonstrably produces this ROM,
  // which settles any doubt about HOW it was paired; anything else about a
  // guessed pairing, or a failed check, is surfaced.
  if (row.patchKey) {
    const v = row.verify;
    if (v && v !== 'running' && v.state === 'mismatch') {
      warnings.push({ id: 'PATCH_MISMATCH', text: "This patch doesn't reproduce this version's ROM when applied to the base ROM — check it's the right patch (or that the ROM has a header the patch doesn't expect)." });
    } else if (v && v !== 'running' && v.state === 'error') {
      warnings.push({ id: 'PATCH_CHECK_ERROR', text: v.detail });
    } else if (row.patchConfidence === 'version' && !(v && v !== 'running' && v.state === 'verified')) {
      warnings.push({ id: 'PATCH_GUESSED', text: 'This patch was matched by version number, not by file name — check it\'s the right one.' });
    }
  }
  return { errors, warnings };
}

/** Stable text for a row's current warnings; an acknowledgement only counts while this is unchanged. */
export function warningSignature(issues: RowIssues): string {
  return issues.warnings.map((w) => w.id).sort().join('|');
}

export function needsAck(issues: RowIssues, row: BulkRow): boolean {
  return issues.warnings.length > 0 && row.ackedWarnings !== warningSignature(issues);
}

/**
 * Display and creation order. Creation order matters: a hack's version chips
 * are ordered by creation time, so versions must be created oldest first.
 */
export function sortRows(rows: BulkRow[], mode: 'version' | 'date'): BulkRow[] {
  const byVersion = (a: BulkRow, b: BulkRow) => versionCompare(a.version, b.version) || a.filename.localeCompare(b.filename, 'en', { numeric: true });
  return [...rows].sort((a, b) => {
    if (mode === 'date') {
      if (a.releaseDate !== b.releaseDate) {
        if (!a.releaseDate) return 1; // undated last
        if (!b.releaseDate) return -1;
        return a.releaseDate < b.releaseDate ? -1 : 1;
      }
    }
    return byVersion(a, b);
  });
}

/**
 * The JSON body for POST /api/submissions for one row. Mirrors what the
 * single form (SubmitForm.handleSubmit) sends, field for field, plus
 * `batchId`. `applyToAllVersions` is always false: a bulk batch must not
 * silently rewrite the shared fields of versions that already exist.
 */
export function buildCreatePayload(args: {
  header: BulkHeader;
  row: BulkRow;
  patch: PatchEntry | null;
  batchId: string;
}): Record<string, unknown> {
  const { header, row, patch, batchId } = args;
  const hash = row.hash!; // callers only send rows that have been hashed
  const hasTranslationTag = header.tags.some((slug) => TRANSLATION_TRIGGER_SLUGS.includes(slug));
  const payload: Record<string, unknown> = {
    hackName: header.hackName.trim(),
    version: row.version.trim(),
    authorId: header.authorId ?? undefined,
    author: !header.authorId && header.legacyAuthor ? header.legacyAuthor : undefined,
    releaseDate: row.releaseDate || undefined,
    platform: header.platform,
    sourceUrl: effectiveSourceUrl(row, header),
    filename: row.filename,
    fileSize: row.fileSize,
    crc32: hash.crc32,
    md5: hash.md5,
    sha1: hash.sha1,
    description: header.description || undefined,
    versionChangelog: row.changelog || undefined,
    patchType: patch?.patchType ?? undefined,
    patchFilename: patch?.filename ?? undefined,
    patchSha1: patch?.sha1 ?? undefined,
    baseRomId: header.baseRomId,
    franchiseId: header.franchiseId ?? undefined,
    releasePageUrl: header.releasePageUrl || undefined,
    githubUrl: header.githubUrl || undefined,
    tags: header.tags,
    // Only meaningful alongside a translation tag. The single form has had a
    // known bug where languages outlive removing that tag (CLAUDE_HANDOFF
    // section 6); this form simply doesn't send them in that case.
    translationLanguages: hasTranslationTag ? header.translationLanguages : [],
    applyToAllVersions: false,
    batchId,
  };
  for (const key of MAPPING_FIELD_KEYS) {
    const v = header.mappings[key as keyof MappingValues];
    if (v) payload[key] = v;
  }
  return payload;
}
