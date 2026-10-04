// src/lib/patchOrganize.ts
//
// The admin "Organize patch files" tool: files every already-uploaded patch
// where buildPatchRelativePath (patchStorage.ts) says it belongs —
//
//   {Platform}/{Base ROM}/{Hack}/{slug}__{sha1}.{ext}
//
// — and records that location in Submission.patchStoredPath. It exists because
// patches used to be stored in one flat folder ({sha1}__{slug}.{ext} directly
// in the storage root); those files keep working untouched (a NULL
// patchStoredPath means "old flat layout"), and this tool is how they get
// moved. It is also safe to run later: a patch whose hack or base ROM was
// renamed since it was filed is simply re-filed under the new names, and a
// patch already in the right place is left alone (idempotent).
//
// SAFETY MODEL — a file the database points at is never absent:
//   1. classify (read-only): work out each patch's current and desired
//      location and check the file really is there. Problems (file missing,
//      something else already at the destination, unreadable) are REPORTED and
//      that patch is left completely alone — nothing is guessed, and nothing
//      is ever overwritten.
//   2. place: add the file at its new path as a second name for the same bytes
//      (hard link; an atomic copy on filesystems without hard links) — the
//      original is still there.
//   3. record: point the database at the new path, guarded by "nothing about
//      this row changed since I read it" (a concurrent re-upload or removal
//      wins; we back out).
//   4. only now remove the old name, and only if NO row still refers to it.
// A crash at any point leaves either the old state or the new state, never a
// submission pointing at a missing file; re-running finishes the job (the
// classify step recognizes a leftover link from an interrupted run as the same
// file). Several submissions can share one physical file (same hash, same
// name) — that's why removal is by reference count, not per row.
//
// A dry run does step 1 only. A real run does steps 2-4 for at most `limit`
// submissions per call AND stops starting new files once a time budget is
// spent (ORGANIZE_TIME_BUDGET_MS) — the request travels through Cloudflare,
// which gives up on a request at roughly 100 s, and on a host without hard
// links each move is a full copy of a possibly multi-GB file. Whatever isn't
// reached is reported as `remaining` and the admin UI simply calls again until
// none is left. At least one file is always handled per call, so every call
// makes progress.

import { promises as fs, type Stats } from 'fs';
import { prisma } from './prisma';
import {
  buildPatchDisplaySlug,
  buildPatchRelativePath,
  describeStoredLocation,
  placeExistingPatchFile,
  pruneEmptyPatchFolders,
  resolveRelativePath,
  resolveStoredPath,
  type StoredPatchRef,
} from './patchStorage';
import type { PatchTypeValue } from './patchTypes';

export const ORGANIZE_DEFAULT_LIMIT = 300;
export const ORGANIZE_MAX_LIMIT = 1000;
/** Stop starting new files after this long (well inside Cloudflare's ~100 s request cap). */
export const ORGANIZE_TIME_BUDGET_MS = 45_000;
const PREVIEW_LIMIT = 200;
const CLASSIFY_CONCURRENCY = 25;

export type OrganizeProblemKind =
  | 'no-patch-identity' // marked uploaded but has no hash/type recorded
  | 'invalid-path' // the stored location fails validation
  | 'source-missing' // the file the database points at isn't on disk
  | 'destination-exists' // a DIFFERENT file already sits at the destination
  | 'inconclusive' // couldn't tell (permissions, mount hiccup...) — left alone
  | 'changed-during-run'; // the row was edited/removed while we worked — left as is

export interface OrganizeProblem {
  id: string;
  hackName: string;
  version: string;
  kind: OrganizeProblemKind;
  detail: string;
  from: string;
  to: string | null;
}

export interface OrganizeMove {
  id: string;
  hackName: string;
  version: string;
  from: string;
  to: string;
}

export interface OrganizeResult {
  dryRun: boolean;
  /** Submissions with an uploaded patch file that were examined. */
  checked: number;
  /** Already at the right path — nothing to do. */
  alreadyOrganized: number;
  /** Patches that needed moving and were ready to (no problem found) when this call began. */
  pending: number;
  /** Moved during THIS call (always 0 for a dry run). */
  moved: number;
  /** Ready to move but not handled in this call because of `limit`. Call again. */
  remaining: number;
  /** Everything left alone and why. Re-detected on every call (not cumulative). */
  problems: OrganizeProblem[];
  /** Dry run: the first moves that WOULD happen. Real run: the first moves made this call. */
  preview: OrganizeMove[];
}

interface Row {
  id: string;
  hackName: string;
  version: string;
  platform: string;
  patchSha1: string | null;
  patchType: string | null;
  patchStoredSlug: string | null;
  patchStoredPath: string | null;
  /** Read so the final write can pin it — see the comment on the updateMany below. */
  updatedAt: Date;
  baseRom: { name: string } | null;
}

interface Plan {
  row: Row;
  ref: StoredPatchRef;
  fromAbs: string;
  fromLabel: string;
  toRel: string;
  toAbs: string;
  newSlug: string;
}

interface ReadyGroup {
  fromAbs: string;
  /** Plans whose destination is clear to proceed. */
  plans: Plan[];
  /** Destination paths that already hold the SAME file (a link left by an interrupted run). */
  alreadyPlaced: Set<string>;
}

function errMessage(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.message || String(err);
}

async function inChunks<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

export async function organizePatchFiles(opts: {
  dryRun: boolean;
  limit?: number;
  /** Override ORGANIZE_TIME_BUDGET_MS (tests). */
  budgetMs?: number;
}): Promise<OrganizeResult> {
  const deadline = Date.now() + (opts.budgetMs ?? ORGANIZE_TIME_BUDGET_MS);
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? ORGANIZE_DEFAULT_LIMIT), 1), ORGANIZE_MAX_LIMIT);

  // Every submission with a file attached, whatever its status — a PENDING
  // submission's owner can upload a patch, and a soft-deleted one can be
  // restored, so none of them are skipped (same scope reasoning as
  // patchReconcile.ts).
  const rows: Row[] = await prisma.submission.findMany({
    where: { patchUploadedAt: { not: null } },
    select: {
      id: true,
      hackName: true,
      version: true,
      platform: true,
      patchSha1: true,
      patchType: true,
      patchStoredSlug: true,
      patchStoredPath: true,
      updatedAt: true,
      baseRom: { select: { name: true } },
    },
    orderBy: { id: 'asc' }, // stable order so successive limited calls make steady progress
  });

  const problems: OrganizeProblem[] = [];
  const plans: Plan[] = [];
  /** How many rows currently point at each physical file — decides when the old name may go. */
  const referenceCount = new Map<string, number>();
  let alreadyOrganized = 0;

  const problem = (
    row: Row,
    kind: OrganizeProblemKind,
    detail: string,
    from: string,
    to: string | null = null
  ) => problems.push({ id: row.id, hackName: row.hackName, version: row.version, kind, detail, from, to });

  // ── plan (no filesystem access) ─────────────────────────────────────
  for (const row of rows) {
    if (!row.patchSha1 || !row.patchType) {
      problem(row, 'no-patch-identity', 'Marked as having an uploaded patch, but no patch hash/type is recorded.', '(unknown)');
      continue;
    }
    const sha1 = row.patchSha1.toLowerCase();
    const patchType = row.patchType as PatchTypeValue;
    const ref: StoredPatchRef = {
      sha1,
      patchType,
      storedPath: row.patchStoredPath,
      storedSlug: row.patchStoredSlug,
    };
    let fromAbs: string;
    let toRel: string;
    let toAbs: string;
    try {
      fromAbs = resolveStoredPath(ref);
      toRel = buildPatchRelativePath({
        platform: row.platform,
        baseRomName: row.baseRom?.name,
        hackName: row.hackName,
        version: row.version,
        sha1,
        patchType,
      });
      toAbs = resolveRelativePath(toRel);
    } catch (err) {
      problem(row, 'invalid-path', errMessage(err), row.patchStoredPath ?? '(legacy location)');
      continue;
    }
    referenceCount.set(fromAbs, (referenceCount.get(fromAbs) ?? 0) + 1);
    if (fromAbs === toAbs) {
      alreadyOrganized++;
      continue;
    }
    plans.push({
      row,
      ref,
      fromAbs,
      fromLabel: describeStoredLocation(ref),
      toRel,
      toAbs,
      newSlug: buildPatchDisplaySlug(row.hackName, row.version),
    });
  }

  // ── classify (read-only filesystem checks) ──────────────────────────
  const byFile = new Map<string, Plan[]>();
  for (const plan of plans) {
    const list = byFile.get(plan.fromAbs) ?? [];
    list.push(plan);
    byFile.set(plan.fromAbs, list);
  }

  const ready: ReadyGroup[] = [];
  await inChunks(Array.from(byFile.entries()), CLASSIFY_CONCURRENCY, async ([fromAbs, group]) => {
    let srcStat: Stats;
    try {
      srcStat = await fs.stat(fromAbs);
      if (!srcStat.isFile()) throw new Error('not a regular file');
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
      for (const p of group) {
        problem(
          p.row,
          missing ? 'source-missing' : 'inconclusive',
          missing ? 'The file is not on disk at the location the database points at.' : errMessage(err),
          p.fromLabel,
          p.toRel
        );
      }
      return;
    }

    const alreadyPlaced = new Set<string>();
    const okPlans: Plan[] = [];
    const checkedDest = new Map<string, 'free' | 'same' | 'blocked'>();
    for (const p of group) {
      let state = checkedDest.get(p.toAbs);
      if (!state) {
        try {
          const destStat = await fs.stat(p.toAbs);
          // Same device + inode = the very same file (a hard link from an
          // interrupted earlier run). Anything else is somebody else's file.
          state = destStat.ino === srcStat.ino && destStat.dev === srcStat.dev ? 'same' : 'blocked';
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
            state = 'free';
          } else {
            problem(p.row, 'inconclusive', errMessage(err), p.fromLabel, p.toRel);
            continue; // not cached: each row reports its own
          }
        }
        checkedDest.set(p.toAbs, state);
      }
      if (state === 'blocked') {
        problem(
          p.row,
          'destination-exists',
          'A different file is already at the destination — left alone, nothing overwritten.',
          p.fromLabel,
          p.toRel
        );
        continue;
      }
      if (state === 'same') alreadyPlaced.add(p.toAbs);
      okPlans.push(p);
    }
    if (okPlans.length > 0) ready.push({ fromAbs, plans: okPlans, alreadyPlaced });
  });
  // Deterministic processing order regardless of the concurrent classify above.
  ready.sort((a, b) => a.plans[0].row.id.localeCompare(b.plans[0].row.id));

  const pending = ready.reduce((n, g) => n + g.plans.length, 0);
  const preview: OrganizeMove[] = [];
  const addPreview = (p: Plan) => {
    if (preview.length < PREVIEW_LIMIT) {
      preview.push({ id: p.row.id, hackName: p.row.hackName, version: p.row.version, from: p.fromLabel, to: p.toRel });
    }
  };

  if (opts.dryRun) {
    for (const g of ready) for (const p of g.plans) addPreview(p);
    return { dryRun: true, checked: rows.length, alreadyOrganized, pending, moved: 0, remaining: pending, problems, preview };
  }

  // ── act ─────────────────────────────────────────────────────────────
  let handled = 0;
  let moved = 0;
  for (const g of ready) {
    // `handled > 0`: always do at least one file, so a call can't make zero progress.
    if (handled >= limit || (handled > 0 && Date.now() > deadline)) break;
    handled += g.plans.length;

    // 2. place — one new name per distinct destination
    const placed = new Map<string, Plan[]>(); // destination -> plans that can use it
    const createdHere = new Set<string>(); // destinations THIS call created (rolled back if unused)
    for (const p of g.plans) {
      const list = placed.get(p.toAbs);
      if (list) {
        list.push(p);
        continue;
      }
      if (!g.alreadyPlaced.has(p.toAbs)) {
        try {
          await placeExistingPatchFile(g.fromAbs, p.toRel);
          createdHere.add(p.toAbs);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          problem(
            p.row,
            code === 'EEXIST' ? 'destination-exists' : 'inconclusive',
            code === 'EEXIST' ? 'Something appeared at the destination while working — left alone.' : errMessage(err),
            p.fromLabel,
            p.toRel
          );
          continue;
        }
      }
      placed.set(p.toAbs, [p]);
    }

    // 3. record — guarded against the row having changed since we read it
    let redirected = 0;
    for (const [toAbs, group] of Array.from(placed.entries())) {
      let usedBy = 0;
      for (const p of group) {
        try {
          // Re-filing a patch is housekeeping, not an edit: Submission.updatedAt is
          // @updatedAt, so a plain update would stamp every organized row with "now" —
          // and hack-family aggregation (entries/hack-family/[id]) uses updatedAt to
          // pick which version's mapping / tags / franchise / author is the "most
          // recently touched". So updatedAt is pinned to the value we read, both in the
          // data (Prisma then doesn't auto-set it) and in the guard (any real edit since
          // we read the row bumps it, so the write matches nothing and the row is left
          // for the next run).
          const res = await prisma.submission.updateMany({
            where: {
              id: p.row.id,
              updatedAt: p.row.updatedAt,
              patchUploadedAt: { not: null },
              patchSha1: p.row.patchSha1,
              patchType: p.row.patchType as PatchTypeValue,
              patchStoredPath: p.row.patchStoredPath,
              patchStoredSlug: p.row.patchStoredSlug,
            },
            data: { patchStoredPath: p.toRel, patchStoredSlug: p.newSlug, updatedAt: p.row.updatedAt },
          });
          if (res.count === 1) {
            usedBy++;
            redirected++;
            moved++;
            addPreview(p);
          } else {
            problem(p.row, 'changed-during-run', 'This submission was edited or its patch replaced/removed while organizing — left as it now is.', p.fromLabel, p.toRel);
          }
        } catch (err) {
          problem(p.row, 'inconclusive', `Could not record the new location: ${errMessage(err)}`, p.fromLabel, p.toRel);
        }
      }
      // A name we created that no row ended up using would be an orphan.
      if (usedBy === 0 && createdHere.has(toAbs)) {
        await fs.unlink(toAbs).catch((err) => console.error('[patchOrganize] could not roll back unused link:', err));
        await pruneEmptyPatchFolders(toAbs);
      }
    }

    // 4. remove the old name — only when every row that pointed at it now points elsewhere
    if (redirected > 0 && redirected === (referenceCount.get(g.fromAbs) ?? 0)) {
      try {
        await fs.unlink(g.fromAbs);
        await pruneEmptyPatchFolders(g.fromAbs);
      } catch (err) {
        // Harmless: the data is intact at the new path (this is just a second
        // name for it). Logged so it isn't invisible.
        console.error(`[patchOrganize] moved, but could not remove the old name ${g.fromAbs}:`, err);
      }
    }
  }

  // Not handled because of the limit or the time budget (not counting rows that turned out to have problems).
  const remaining = Math.max(pending - handled, 0);
  return { dryRun: false, checked: rows.length, alreadyOrganized, pending, moved, remaining, problems, preview };
}
