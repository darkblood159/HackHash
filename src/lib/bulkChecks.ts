// src/lib/bulkChecks.ts
//
// The per-row database checks for bulk submit, in ONE function used two ways:
//   - POST /api/submissions/precheck runs it as a dry run so the review table
//     can show every problem BEFORE anything is written, and
//   - createSubmissionCore re-enforces the blocking subset when a row is
//     actually created under a batch, so a client that skips the precheck
//     (or a stale table) can't get past the server.
// Keeping both on the same code is the point: "what the table warned about"
// and "what the server refuses" can't drift apart.
//
// What blocks a row (errors) vs what only needs an acknowledgement
// (warnings) is decided here, not in the UI:
//   errors:   exact SHA-1 already in the catalog (same rule as create),
//             SHA-1 repeated inside the batch, the same version label twice
//             in the batch, the row's file IS a base ROM (they dropped the
//             unpatched game instead of the hack).
//   warnings: this version label already exists for this hack (nothing in
//             the schema forbids two "1.0" rows, so it's a nudge, not a wall),
//             and the chosen base ROM is still pending review.

import { prisma } from './prisma';
import { normalizeNameKey } from './hackFamily';
import { validateBaseRomAssignment, BaseRomAssignError } from './baseRom';

export interface BulkRowInput {
  clientId: string;
  version: string;
  sha1: string;
}

export interface RowIssue {
  code: 'DUPLICATE_SHA1' | 'DUPLICATE_IN_BATCH' | 'DUPLICATE_VERSION_IN_BATCH' | 'IS_BASE_ROM' | 'VERSION_EXISTS';
  message: string;
  /** Site-relative link to the conflicting entry, when there is one. */
  href?: string;
}

export interface RowCheckResult {
  clientId: string;
  errors: RowIssue[];
  warnings: RowIssue[];
}

export interface BulkPrecheckResult {
  baseRom: { id: string; name: string; sha1: string; status: string } | null;
  /** Set when the chosen base ROM can't be used at all (wrong platform, rejected, gone). */
  baseRomError: string | null;
  baseRomWarning: string | null;
  rows: RowCheckResult[];
}

/** Same wording wherever it appears — the precheck and the create refusal. */
export function describeIsBaseRom(baseRomName: string): string {
  return `This file is the unpatched base ROM "${baseRomName}" itself, not a hack of it — drop the patched ROM instead.`;
}

/** Trim + lowercase, the comparison used for "same version label". */
export function versionKey(version: string): string {
  return version.trim().toLowerCase();
}

export async function checkBulkRows(args: {
  hackName: string;
  platform: string;
  /**
   * null = the person hasn't picked a base ROM yet. Everything below that
   * doesn't depend on the base ROM (duplicate files, repeats, an existing
   * version label) is still checked, so the review table can flag those as
   * soon as the files are dropped rather than only after a base ROM is
   * chosen. Sending still requires a base ROM (the form and create enforce it).
   */
  baseRomId: string | null;
  rows: BulkRowInput[];
}): Promise<BulkPrecheckResult> {
  const { hackName, platform, baseRomId, rows } = args;
  const sha1s = rows.map((r) => r.sha1.toLowerCase());

  // ── base ROM ──
  let baseRomError: string | null = null;
  let baseRomWarning: string | null = null;
  let baseRomRow: BulkPrecheckResult['baseRom'] = null;
  if (baseRomId) {
    try {
      const validated = await validateBaseRomAssignment(prisma, baseRomId, platform);
      if (validated.status === 'PENDING') {
        baseRomWarning = `The base ROM "${validated.name}" is still pending review. Your versions can be submitted, but they'll be hard to verify until it's approved.`;
      }
    } catch (err) {
      if (err instanceof BaseRomAssignError) baseRomError = err.message;
      else throw err;
    }
    baseRomRow = await prisma.baseRom.findUnique({
      where: { id: baseRomId },
      select: { id: true, name: true, sha1: true, status: true },
    });
  }

  // ── database lookups, one query each for the whole table ──
  const [existingBySha1, baseRomsBySha1, family] = await Promise.all([
    // Same predicate createSubmissionCore's duplicate check uses.
    prisma.submission.findMany({
      where: { sha1: { in: sha1s }, status: { not: 'REJECTED' } },
      select: { id: true, sha1: true, hackName: true, version: true },
    }),
    prisma.baseRom.findMany({ where: { sha1: { in: sha1s } }, select: { sha1: true, name: true } }),
    prisma.hackFamily.findUnique({
      where: { nameKey_platform: { nameKey: normalizeNameKey(hackName), platform: platform as never } },
      select: { id: true },
    }),
  ]);
  const familyVersions = family
    ? await prisma.submission.findMany({
        where: { hackFamilyId: family.id, status: { not: 'REJECTED' }, deletedAt: null },
        select: { id: true, version: true },
      })
    : [];

  const existingBySha1Map = new Map(existingBySha1.map((s) => [s.sha1.toLowerCase(), s]));
  const baseRomBySha1Map = new Map(baseRomsBySha1.map((b) => [b.sha1.toLowerCase(), b]));

  // Repeats inside the table itself.
  const shaCount = new Map<string, number>();
  const verCount = new Map<string, number>();
  for (const r of rows) {
    const s = r.sha1.toLowerCase();
    shaCount.set(s, (shaCount.get(s) ?? 0) + 1);
    const v = versionKey(r.version);
    if (v) verCount.set(v, (verCount.get(v) ?? 0) + 1);
  }

  const results: RowCheckResult[] = rows.map((r) => {
    const errors: RowIssue[] = [];
    const warnings: RowIssue[] = [];
    const sha = r.sha1.toLowerCase();
    const ver = versionKey(r.version);

    const dup = existingBySha1Map.get(sha);
    if (dup) {
      errors.push({
        code: 'DUPLICATE_SHA1',
        message: `This exact file is already in HackHash as ${dup.hackName} v${dup.version}.`,
        href: `/submissions/${dup.id}`,
      });
    }
    if ((shaCount.get(sha) ?? 0) > 1) {
      errors.push({ code: 'DUPLICATE_IN_BATCH', message: 'The same file appears more than once in this batch.' });
    }
    if (ver && (verCount.get(ver) ?? 0) > 1) {
      errors.push({ code: 'DUPLICATE_VERSION_IN_BATCH', message: `More than one row is labelled "${r.version.trim()}".` });
    }
    const asBase = baseRomBySha1Map.get(sha);
    if (asBase) {
      errors.push({ code: 'IS_BASE_ROM', message: describeIsBaseRom(asBase.name) });
    }
    const sameVersion = ver ? familyVersions.find((s) => versionKey(s.version) === ver) : undefined;
    if (sameVersion) {
      warnings.push({
        code: 'VERSION_EXISTS',
        message: `A version labelled "${r.version.trim()}" of this hack already exists.`,
        href: `/submissions/${sameVersion.id}`,
      });
    }
    return { clientId: r.clientId, errors, warnings };
  });

  return {
    baseRom: baseRomRow,
    baseRomError,
    baseRomWarning,
    rows: results,
  };
}
