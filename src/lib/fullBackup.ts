// src/lib/fullBackup.ts
//
// Full-database backup/restore — a true disaster-recovery export, separate
// from (and much broader than) the DAT detailed export in dat-generator.ts.
// That export is scoped to the public, approved-only catalog and
// deliberately re-keys everything by name on re-import, because it's meant
// to be re-importable into a DIFFERENT, already-populated database. This one
// is the opposite: every row of every table below — PENDING/REJECTED/
// soft-deleted submissions included — restored with its ORIGINAL id, meant
// for rebuilding an empty (or intentionally wiped) database back to exactly
// what it was, not merging into a live one. See RESTORE_ORDER below for why
// literal-id restore is possible and safe here in a way it wouldn't be for
// the DAT export's use case.
//
// WHAT'S INCLUDED: every row that carries real community data — users
// (role/trust score/ban state), the minimal OAuth account links needed to
// match a returning login back to its user (see below), submissions
// (including who submitted each one and who uploaded its patch), verification
// votes, trust-score history, comments, tags, hack families + their
// dismissed-duplicate decisions, base ROMs, alternate formats, duplicate
// reports, screenshots, DAT import history, pending/reviewed change
// requests, and site settings.
//
// WHAT'S DELIBERATELY EXCLUDED, AND WHY:
//   - Session, VerificationToken: short-lived NextAuth auth-state rows.
//     Meaningless after a restore (a pre-restore session token can't still
//     be live in anyone's browser) — everyone just signs back in, which is
//     also the moment Account below does its job.
//   - Account's OAuth secrets (access_token/refresh_token/id_token/
//     token_type/scope/session_state/expires_at): NOT needed for a
//     returning sign-in to find its way back to the right User row — that
//     only needs provider+providerAccountId (see @auth/prisma-adapter's
//     getUserByAccount, used by src/lib/auth.ts). Deliberately never written
//     into a downloadable backup file, which will realistically end up
//     stored less carefully than the live database itself.
//   - AuditLog, SyncJob: operational/history logs. Not asked for, not core
//     to "the database" in the sense meant here (who submitted what, who
//     verified what, who has what role/trust). AuditLog.userId/submissionId
//     are both ON DELETE SET NULL, so leaving it out of WIPE/RESTORE_ORDER
//     is safe — a restore just nulls those two columns on any log rows that
//     pointed at a wiped user/submission, it doesn't block the wipe.
//   - ChangeRequest was meant to be excluded on the same reasoning, but
//     ISN'T anymore, and can't safely be: unlike AuditLog, both
//     ChangeRequest.submissionId and .requestedById are ON DELETE RESTRICT
//     (see prisma/migrations/20260622020707_expand_platform_enum). Excluding
//     it from WIPE_ORDER doesn't skip touching those rows, it just means
//     Postgres refuses the Submission/User deleteMany the moment any live
//     ChangeRequest still points at the row being deleted — exactly the
//     "violates RESTRICT setting of foreign key constraint
//     ChangeRequest_submissionId_fkey" error this caused in practice.
//     Harmless against a truly empty DB (a real from-scratch disaster has no
//     surviving ChangeRequest rows to conflict with either), but a restore
//     run against a live/populated database — arguably the more common
//     "roll back to last night's backup" use of this feature — hit it
//     immediately. Now included for real, in RESTORE_ORDER/WIPE_ORDER like
//     every other table.
//
// PATCH FILES THEMSELVES: never touched by this file. Patch storage is a
// bind-mounted host directory, independent of the database by design (see
// src/lib/patchStorage.ts) — restoring the database doesn't restore patch
// bytes, since a real disaster that took out the database didn't necessarily
// also take out that separate mount. What a restore DOES do is verify (see
// verifyAndFixPatchState below) that every restored submission's claimed
// patchUploadedAt still corresponds to a real file on disk, and quietly
// downgrades any that don't — see that function's own comment for why.

import { prisma } from './prisma';
import { statPatchFileStrict } from './patchStorage';
import type { PatchTypeValue } from './patchTypes';

export const FULL_BACKUP_FORMAT_VERSION = 1;

// Same pragmatic choice as hackFamily.ts's TxClient — the specific
// Prisma-generated transaction client type isn't imported here, `any`
// covers the interactive $transaction callback client used throughout
// restoreFullBackup below.
type TxClient = any;

// ─── Date/BigInt helpers ────────────────────────────────────────────────────
// JSON.stringify already turns a Date into an ISO string on its own (Date
// defines toJSON), so exporting needs no date handling beyond passing rows
// through — these exist for the one direction JSON.parse can't undo on its
// own: turning those ISO strings back into real Date objects, and BigInt
// (which JSON has no representation for at all, in either direction).

const parseDate = (s: unknown): Date | null => (s ? new Date(s as string) : null);
const parseDateReq = (s: unknown): Date => new Date(s as string);
const bi = (s: unknown): bigint => BigInt(s as string);

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Applies a table's ROW_MAPPERS entry to every row, but with row-level error
// context — a raw error from inside a mapper (a required field missing,
// wrong type, etc.) gives no indication of WHICH row caused it once it's
// bubbled up through createMany/the transaction/the API route's generic
// catch block. This turns that into something an admin can actually act on.
function mapRows(key: string, rows: any[]): any[] {
  const mapper = ROW_MAPPERS[key];
  return rows.map((row, index) => {
    try {
      return mapper(row);
    } catch (err: any) {
      throw new FullBackupValidationError(
        `Backup file's "${key}" table, row ${index}: ${err?.message || 'malformed row'}.`
      );
    }
  });
}

// Postgres has a hard 65535-bind-parameter limit per statement, and
// createMany sends one INSERT with every row's every column as a parameter.
// Submission is the widest table here at roughly 30 columns; 500 rows ×
// 30 cols = 15,000 params, comfortably under the limit with headroom for
// every narrower table too — one size kept simple rather than tuned
// per-model.
const BATCH_SIZE = 500;

async function insertChunked(rows: any[], create: (batch: any[]) => Promise<unknown>) {
  for (const batch of chunk(rows, BATCH_SIZE)) {
    await create(batch);
  }
}

// ─── Export ──────────────────────────────────────────────────────────────

export interface FullBackupPayload {
  formatVersion: number;
  generatedAt: string;
  generatedBy: { id: string; name: string | null } | null;
  // Row count per table, written by the exporter and re-checked against the
  // actual array lengths on restore as a cheap corruption/truncation guard.
  counts: Record<string, number>;
  data: Record<string, any[]>;
}

export async function generateFullBackup(
  generatedBy: { id: string; name: string | null } | null
): Promise<FullBackupPayload> {
  const [
    users,
    accounts,
    tags,
    gameMappings,
    hackFamilies,
    dismissedFamilyPairs,
    baseRoms,
    franchises,
    authors,
    datImports,
    submissions,
    changeRequests,
    approvedEntries,
    verifications,
    trustEvents,
    comments,
    submissionTags,
    alternateFormats,
    duplicateReports,
    screenshots,
    siteSettings,
  ] = await Promise.all([
    prisma.user.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.account.findMany(),
    prisma.tag.findMany(),
    prisma.gameMapping.findMany(),
    prisma.hackFamily.findMany(),
    prisma.dismissedFamilyPair.findMany(),
    prisma.baseRom.findMany(),
    prisma.franchise.findMany(),
    prisma.author.findMany(),
    prisma.datImport.findMany(),
    prisma.submission.findMany(),
    prisma.changeRequest.findMany(),
    prisma.approvedEntry.findMany(),
    prisma.verification.findMany(),
    prisma.trustEvent.findMany(),
    prisma.comment.findMany(),
    prisma.submissionTag.findMany(),
    prisma.alternateFormat.findMany(),
    prisma.duplicateReport.findMany(),
    prisma.screenshot.findMany(),
    prisma.siteSetting.findMany(),
  ]);

  const data: Record<string, any[]> = {
    // Every field that isn't a BigInt round-trips through JSON.stringify
    // unassisted — a Date defines its own toJSON() (produces an ISO
    // string), and null already serializes to `null` on its own. BigInt is
    // the one type JSON has genuinely no representation for in either
    // direction (JSON.stringify throws on a raw BigInt) — .toString() here,
    // BigInt(str) in the matching ROW_MAPPERS entry below.
    users: users,
    // Deliberately NOT a full spread — see file header. Only the three
    // fields next-auth's adapter actually needs to re-link a returning
    // sign-in to this user; every OAuth secret is dropped on purpose.
    accounts: accounts.map((a) => ({
      userId: a.userId,
      type: a.type,
      provider: a.provider,
      providerAccountId: a.providerAccountId,
    })),
    tags: tags,
    gameMappings: gameMappings,
    hackFamilies: hackFamilies,
    dismissedFamilyPairs: dismissedFamilyPairs,
    baseRoms: baseRoms,
    franchises: franchises,
    authors: authors,
    datImports: datImports,
    submissions: submissions.map((s) => ({ ...s, fileSize: s.fileSize.toString() })),
    changeRequests: changeRequests,
    approvedEntries: approvedEntries.map((e) => ({ ...e, fileSize: e.fileSize.toString() })),
    verifications: verifications,
    trustEvents: trustEvents,
    comments: comments,
    submissionTags: submissionTags,
    alternateFormats: alternateFormats.map((a) => ({ ...a, fileSize: a.fileSize.toString() })),
    duplicateReports: duplicateReports,
    screenshots: screenshots,
    siteSettings: siteSettings,
  };

  const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length]));

  return {
    formatVersion: FULL_BACKUP_FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    generatedBy,
    counts,
    data,
  };
}

// ─── Restore ─────────────────────────────────────────────────────────────
//
// RESTORE_ORDER — parents before children, so every foreign key a row
// carries already exists by the time that row is inserted. WIPE_ORDER below
// is the exact reverse for the same reason, applied at delete time: a row
// must be gone before whatever it points at is allowed to go.
//
// This full topological order was worked out directly from
// prisma/schema.prisma's own @relation fields (not assumed) — e.g.
// ApprovedEntry.approvedById and Submission.deletedById are plain String
// columns with NO @relation attached, so they impose no ordering
// constraint despite the name; DismissedFamilyPair.dismissedById is the
// same. Re-check the schema before adding a new table here.

const RESTORE_ORDER = [
  'users',
  'accounts',
  'tags',
  'gameMappings',
  'hackFamilies',
  'dismissedFamilyPairs',
  'baseRoms',
  // Before 'submissions' — Submission.franchiseId is a foreign key to this.
  'franchises',
  // Before 'submissions' too — Submission.authorId is a foreign key to this.
  'authors',
  'datImports',
  'submissions',
  // After 'submissions' and 'users' — ChangeRequest.submissionId and
  // .requestedById are both foreign keys to those, and (unlike most FKs in
  // this app) both ON DELETE RESTRICT rather than SET NULL/CASCADE, so this
  // table's position here is load-bearing, not just tidy grouping: get it
  // wrong and WIPE_ORDER (this list, reversed) tries to delete a Submission
  // or User a live ChangeRequest still points at. See the file header.
  'changeRequests',
  'approvedEntries',
  'verifications',
  'trustEvents',
  'comments',
  'submissionTags',
  'alternateFormats',
  'duplicateReports',
  'screenshots',
  'siteSettings',
] as const;

const WIPE_ORDER = [...RESTORE_ORDER].reverse();

// Tables added AFTER a given backup was made simply don't exist in that file
// — a backup taken before franchises shipped has no "franchises" key at all.
// That's a complete, valid backup of the schema as it was then, not
// corruption, so a missing key for these is treated as an empty table
// (validatePayload below) instead of making every older backup unrestorable
// the moment this table exists. A key that IS present must still be a real
// array with a matching count, like any other table.
//
// 'changeRequests' is here for the same reason, not because the table is
// new: a backup taken with the earlier version of this exporter (before
// ChangeRequest was wired into RESTORE_ORDER — see file header) has no
// "changeRequests" key either. Restoring one of those files still restores
// everything it does have; any change requests live in the database at
// restore time are wiped along with it, same trade-off an old
// franchise-less backup already makes for franchises.
// 'authors' is optional for the same reason 'franchises' is: a backup taken before the Author
// list shipped has no "authors" key, and that's a complete, valid backup of the schema as it was then.
const OPTIONAL_TABLES = ['franchises', 'authors', 'changeRequests'] as const;

// tx.model.deleteMany({}) for a table name that isn't a Prisma delegate
// (there isn't one — this list is hand-matched 1:1 against RESTORE_ORDER
// above) would throw, which is exactly the fail-loud behavior wanted here.
const MODEL_FOR_KEY: Record<string, string> = {
  users: 'user',
  accounts: 'account',
  tags: 'tag',
  gameMappings: 'gameMapping',
  hackFamilies: 'hackFamily',
  dismissedFamilyPairs: 'dismissedFamilyPair',
  baseRoms: 'baseRom',
  franchises: 'franchise',
  authors: 'author',
  datImports: 'datImport',
  submissions: 'submission',
  changeRequests: 'changeRequest',
  approvedEntries: 'approvedEntry',
  verifications: 'verification',
  trustEvents: 'trustEvent',
  comments: 'comment',
  submissionTags: 'submissionTag',
  alternateFormats: 'alternateFormat',
  duplicateReports: 'duplicateReport',
  screenshots: 'screenshot',
  siteSettings: 'siteSetting',
};

// Per-table row mappers: JSON row -> Prisma createMany scalar input. Mirrors
// generateFullBackup's mapping in reverse. Deliberately permissive about
// missing optional fields (?? null) since a hand-edited or older backup
// file is plausible; required fields are allowed to throw here rather than
// silently substitute a wrong default — mapRows below catches that and
// re-throws with the table name and row index attached, so a restore
// failure points at exactly which row of which table is malformed instead
// of a bare Prisma/JS error with no context. The transaction rolls back
// either way.
const ROW_MAPPERS: Record<string, (r: any) => any> = {
  users: (u) => ({
    id: u.id,
    name: u.name ?? null,
    email: u.email ?? null,
    emailVerified: parseDate(u.emailVerified),
    image: u.image ?? null,
    username: u.username ?? null,
    bio: u.bio ?? null,
    role: u.role,
    trustScore: u.trustScore ?? 0,
    isBanned: !!u.isBanned,
    createdAt: parseDateReq(u.createdAt),
    updatedAt: parseDateReq(u.updatedAt),
  }),
  accounts: (a) => ({
    // No `id` here — Account.id has @default(cuid()) in schema, so
    // omitting it lets Prisma generate a fresh one on restore. Accounts
    // were deliberately exported WITHOUT their original id (only the 3
    // identity fields — see file header), and nothing in this app keys off
    // an Account row's own id anywhere, only userId/provider/
    // providerAccountId.
    userId: a.userId,
    type: a.type,
    provider: a.provider,
    providerAccountId: a.providerAccountId,
  }),
  tags: (t) => ({ id: t.id, name: t.name, slug: t.slug, tier: t.tier, description: t.description ?? null, tagGroup: t.tagGroup ?? null }),
  gameMappings: (m) => ({
    ...m,
    canonicalReleaseDate: parseDate(m.canonicalReleaseDate),
    hasheousSyncedAt: parseDate(m.hasheousSyncedAt),
    hasheousPushedAt: parseDate(m.hasheousPushedAt),
    hasheousPushVerifiedAt: parseDate(m.hasheousPushVerifiedAt),
    createdAt: parseDateReq(m.createdAt),
    updatedAt: parseDateReq(m.updatedAt),
  }),
  hackFamilies: (f) => ({
    ...f,
    releaseDate: parseDate(f.releaseDate),
    createdAt: parseDateReq(f.createdAt),
    updatedAt: parseDateReq(f.updatedAt),
  }),
  dismissedFamilyPairs: (p) => ({ ...p, dismissedAt: parseDateReq(p.dismissedAt) }),
  baseRoms: (b) => ({ ...b, approvedAt: parseDate(b.approvedAt), createdAt: parseDateReq(b.createdAt) }),
  franchises: (f) => ({ ...f, approvedAt: parseDate(f.approvedAt), createdAt: parseDateReq(f.createdAt) }),
  authors: (a) => ({ ...a, approvedAt: parseDate(a.approvedAt), createdAt: parseDateReq(a.createdAt) }),
  datImports: (d) => ({ ...d, reversedAt: parseDate(d.reversedAt), createdAt: parseDateReq(d.createdAt) }),
  submissions: (s) => ({
    ...s,
    fileSize: bi(s.fileSize),
    releaseDate: parseDate(s.releaseDate),
    patchUploadedAt: parseDate(s.patchUploadedAt),
    createdAt: parseDateReq(s.createdAt),
    updatedAt: parseDateReq(s.updatedAt),
    deletedAt: parseDate(s.deletedAt),
  }),
  // Json fields (changes/proposedTags/proposedTranslationLanguages/
  // proposedFamily/proposedBaseRom/proposedFranchise/proposedAuthor) need no date/BigInt
  // handling of their own — they only ever hold plain strings/booleans/null
  // (see the schema comments on each), which JSON.stringify/parse already
  // round-trip correctly on their own.
  changeRequests: (c) => ({
    id: c.id,
    submissionId: c.submissionId,
    requestedById: c.requestedById,
    changes: c.changes,
    applyToAllVersions: c.applyToAllVersions ?? true,
    proposedTags: c.proposedTags ?? null,
    proposedTranslationLanguages: c.proposedTranslationLanguages ?? null,
    proposedFamily: c.proposedFamily ?? null,
    proposedBaseRom: c.proposedBaseRom ?? null,
    proposedFranchise: c.proposedFranchise ?? null,
    proposedAuthor: c.proposedAuthor ?? null,
    reason: c.reason ?? null,
    status: c.status,
    reviewedById: c.reviewedById ?? null,
    reviewedAt: parseDate(c.reviewedAt),
    reviewNote: c.reviewNote ?? null,
    createdAt: parseDateReq(c.createdAt),
  }),
  approvedEntries: (e) => ({
    ...e,
    fileSize: bi(e.fileSize),
    approvedAt: parseDateReq(e.approvedAt),
    updatedAt: parseDateReq(e.updatedAt),
  }),
  verifications: (v) => ({ ...v, createdAt: parseDateReq(v.createdAt) }),
  trustEvents: (t) => ({ ...t, createdAt: parseDateReq(t.createdAt) }),
  comments: (c) => ({ ...c, createdAt: parseDateReq(c.createdAt), updatedAt: parseDateReq(c.updatedAt) }),
  submissionTags: (t) => ({ submissionId: t.submissionId, tagId: t.tagId }),
  alternateFormats: (a) => ({
    ...a,
    fileSize: bi(a.fileSize),
    reviewedAt: parseDate(a.reviewedAt),
    createdAt: parseDateReq(a.createdAt),
  }),
  duplicateReports: (d) => ({ ...d, createdAt: parseDateReq(d.createdAt) }),
  screenshots: (s) => ({ ...s, createdAt: parseDateReq(s.createdAt) }),
  siteSettings: (s) => ({ ...s, updatedAt: parseDateReq(s.updatedAt) }),
};

export interface RestoreResult {
  wiped: Record<string, number>;
  restored: Record<string, number>;
  // Submissions whose backed-up patchUploadedAt was DEFINITIVELY not found
  // on disk (ENOENT specifically) — see verifyAndFixPatchState.
  patchesUnavailable: number;
  // Submissions the disk check couldn't get a definitive answer for
  // (anything other than a clean ENOENT) — deliberately left untouched
  // rather than guessed at. Non-zero means worth checking server logs for
  // the specific errors and/or running the "Reconcile patch files" repair
  // tool (src/lib/patchReconcile.ts) afterward.
  patchesInconclusive: number;
}

export class FullBackupValidationError extends Error {}

function validatePayload(payload: any): asserts payload is FullBackupPayload {
  if (!payload || typeof payload !== 'object') {
    throw new FullBackupValidationError('Not a valid backup file (not a JSON object).');
  }
  if (payload.formatVersion !== FULL_BACKUP_FORMAT_VERSION) {
    throw new FullBackupValidationError(
      `Unsupported backup format version ${payload.formatVersion ?? '(missing)'} — this build expects version ${FULL_BACKUP_FORMAT_VERSION}. This file may be from an older or newer HackHash build.`
    );
  }
  if (!payload.data || typeof payload.data !== 'object') {
    throw new FullBackupValidationError('Backup file is missing its "data" section.');
  }
  for (const key of OPTIONAL_TABLES) {
    if (payload.data[key] === undefined) payload.data[key] = [];
  }
  for (const key of RESTORE_ORDER) {
    if (!Array.isArray(payload.data[key])) {
      throw new FullBackupValidationError(`Backup file is missing or has a corrupted "${key}" table.`);
    }
    const expected = payload.counts?.[key];
    if (typeof expected === 'number' && expected !== payload.data[key].length) {
      throw new FullBackupValidationError(
        `"${key}" has ${payload.data[key].length} rows but the file's own count says ${expected} — the file looks truncated or edited. Refusing to restore.`
      );
    }
  }
}

export async function restoreFullBackup(payload: unknown): Promise<RestoreResult> {
  validatePayload(payload);
  const data = payload.data;

  const wiped: Record<string, number> = {};
  const restored: Record<string, number> = {};

  await prisma.$transaction(
    async (tx: TxClient) => {
      // Wipe first — children before parents (WIPE_ORDER), so a still-
      // referenced parent row is never deleted out from under a child that
      // hasn't been removed yet. Session isn't part of the backup (see file
      // header) but is cleared here too: once Users are about to be
      // replaced, any live session token is stale regardless.
      for (const key of WIPE_ORDER) {
        const model = MODEL_FOR_KEY[key];
        wiped[key] = await tx[model].count();
        await tx[model].deleteMany({});
      }
      await tx.session.deleteMany({});

      // Then restore — parents before children (RESTORE_ORDER).
      for (const key of RESTORE_ORDER) {
        const model = MODEL_FOR_KEY[key];
        const rows = mapRows(key, data[key] as any[]);
        await insertChunked(rows, (batch) => tx[model].createMany({ data: batch, skipDuplicates: true }));
        restored[key] = rows.length;
      }
    },
    // Generous timeout — a large restore is a single long-running
    // transaction by design (see file header: all-or-nothing, so a failure
    // partway through never leaves the database half-wiped). Raise this
    // further if Dark's dataset grows enough to need it.
    { timeout: 300_000, maxWait: 30_000 }
  );

  const { patchesUnavailable, patchesInconclusive } = await verifyAndFixPatchState();

  return { wiped, restored, patchesUnavailable, patchesInconclusive };
}

// After a restore, every submission's patchUploadedAt/patchStoredSlug/
// patchSha1/patchType came back exactly as backed up — unlike the DAT
// detailed-export re-import (see admin/import/route.ts), nothing here was
// re-derived or guessed at. That's correct IF the physical file is still
// sitting in patch storage (a separate bind-mounted directory the database
// backup never touches — see file header), but a real disaster could have
// taken out that mount too, or it could just be a different host with a
// fresh, empty one. Rather than leave submissions claiming a patch that
// isn't actually there — a download button that 404s the moment someone
// clicks it — this checks every one against disk and downgrades any that
// are DEFINITIVELY missing back to "declared but not uploaded" (patchType/
// patchSha1/patchFilename left alone; patchUploadedAt/patchUploadedById/
// patchFileSize/patchStoredSlug cleared), the same state a submission that
// never had a patch uploaded is already in.
//
// Uses statPatchFileStrict, not statPatchFile — a plain "couldn't confirm
// it" (a permissions issue, a transient mount hiccup, too many concurrent
// handles during a batch) must NEVER be treated the same as "genuinely not
// there," because this function's whole job is deciding whether to
// destructively clear real data. Collapsing the two together very nearly
// caused a real data-loss incident: an earlier version of this function
// used the plain (non-strict) check and ALSO forgot to lowercase
// patchSha1 before comparing against disk (every other call site in this
// codebase — the GET/DELETE routes in
// src/app/api/submissions/[id]/patch/route.ts — does `.toLowerCase()`
// first; this one didn't), and a real restore run against real production
// data incorrectly cleared patch state for 24 submissions whose files were
// genuinely still there. See src/lib/patchReconcile.ts for the repair
// tool built to undo exactly that, and CLAUDE_HANDOFF.txt for the full
// incident writeup. Anything this function can't get a definitive answer
// on is left completely untouched and counted separately
// (patchesInconclusive) rather than guessed at either way.
async function verifyAndFixPatchState(): Promise<{ patchesUnavailable: number; patchesInconclusive: number }> {
  const candidates = await prisma.submission.findMany({
    where: { patchUploadedAt: { not: null } },
    select: { id: true, patchSha1: true, patchType: true, patchStoredSlug: true },
  });

  const missingIds: string[] = [];
  let inconclusive = 0;
  for (const batch of chunk(candidates, 50)) {
    await Promise.all(
      batch.map(async (c) => {
        if (!c.patchSha1 || !c.patchType) {
          // No declared identity at all to even check against disk — this
          // shouldn't be reachable in practice (patchUploadedAt is only
          // ever set alongside both), but if it somehow is, "definitely
          // missing" is the correct, honest read: there's nothing on disk
          // this COULD be pointing at.
          missingIds.push(c.id);
          return;
        }
        const result = await statPatchFileStrict(
          c.patchSha1.toLowerCase(),
          c.patchType as PatchTypeValue,
          c.patchStoredSlug || 'patch'
        );
        if (result.status === 'not-found') missingIds.push(c.id);
        else if (result.status === 'error') {
          inconclusive++;
          console.error(`[fullBackup] couldn't confirm patch file for submission ${c.id} — left untouched:`, result.error);
        }
      })
    );
  }

  if (missingIds.length > 0) {
    await prisma.submission.updateMany({
      where: { id: { in: missingIds } },
      data: { patchUploadedAt: null, patchUploadedById: null, patchFileSize: null, patchStoredSlug: null },
    });
  }

  return { patchesUnavailable: missingIds.length, patchesInconclusive: inconclusive };
}
