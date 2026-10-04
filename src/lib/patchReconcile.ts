// src/lib/patchReconcile.ts
//
// A general "does storage actually agree with the database?" repair tool —
// scans every submission that DECLARES a patch (patchSha1+patchType set)
// but isn't currently marked as having one uploaded, checks the real file
// on disk, and reattaches it if it's genuinely there. Independent of any
// particular restore — useful any time storage and the database might have
// drifted apart for any reason.
//
// BUILT DIRECTLY IN RESPONSE TO A REAL INCIDENT: a full-database restore's
// own post-restore verification step (src/lib/fullBackup.ts's
// verifyAndFixPatchState) had two bugs — it never lowercased patchSha1
// before checking disk, and it treated ANY filesystem error the same as
// "genuinely not found." Together these caused a real restore, run against
// real production data, to incorrectly clear patch-uploaded state for 24
// submissions whose files were actually still sitting untouched in
// storage the whole time. Both bugs are fixed at the source (see
// verifyAndFixPatchState's own comment and statPatchFileStrict in
// patchStorage.ts), but that doesn't undo damage a restore already did
// before the fix existed — this is that undo. See CLAUDE_HANDOFF.txt for
// the full incident writeup.
//
// Deliberately conservative in the same way the fixed verifyAndFixPatchState
// now is: only ever ACTS (reattaches) on a definitive "found," only ever
// counts as "genuinely missing" a definitive ENOENT, and leaves anything
// inconclusive (a permissions issue, a transient error) completely
// untouched and separately reported rather than guessed at either way.
//
// SCOPE: the candidate query below has no status/approval filter at all —
// PENDING, COMMUNITY_VERIFIED, RECOMMENDED, APPROVED, REJECTED, DISPUTED
// submissions are all checked alike, matching the real rule (see
// src/lib/patchPermissions.ts) that a patch can be uploaded to a still-
// PENDING submission by its own owner, not just an approved one. This
// isn't just asserted in this comment — ReconcileResult.byStatus reports
// the actual breakdown of what got checked, specifically so that scope is
// directly visible in the result rather than something to take on faith.

import { prisma } from './prisma';
import {
  statPatchFileStrict,
  buildPatchDisplaySlug,
  buildPatchRelativePath,
  resolveStoredPath,
  type StoredPatchRef,
  type PatchFileCheckResult,
} from './patchStorage';
import type { PatchTypeValue } from './patchTypes';

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export interface ReconcileProblemDetail {
  id: string;
  hackName: string;
  version: string;
  // The submission's own status (PENDING/COMMUNITY_VERIFIED/RECOMMENDED/
  // APPROVED/REJECTED/DISPUTED) — included specifically so it's directly
  // visible, not inferred, that this tool's candidate pool is NOT
  // restricted to approved submissions. Patches can legitimately be
  // uploaded to a still-PENDING submission by its own owner (see
  // src/lib/patchPermissions.ts's canManagePatchFile) — the candidate
  // query below has no status filter at all, matching that reality.
  status: string;
  outcome: 'genuinely-missing' | 'inconclusive';
  // The exact path this tool checked, so it can be checked by hand
  // (`ls`/`stat` inside the container, or on the host if the bind mount
  // is browsable directly) against what's really on disk — no guessing.
  attemptedPath: string;
  // Only set for outcome 'inconclusive' — the raw error statPatchFileStrict
  // got back, so a genuinely-missing-file case and a permissions/mount/
  // concurrency error are never confused with each other in the output
  // either, the same distinction the fix this tool exists for is about.
  error?: string;
}

export interface ReconcileResult {
  // Submissions checked: declared a patch identity, not currently marked
  // as uploaded. NOT filtered by status — see byStatus below, which
  // exists specifically to make that provable rather than asserted.
  checked: number;
  // Checked-count broken down by the submission's own status, e.g.
  // {PENDING: 12, APPROVED: 60, REJECTED: 6}. If this tool were somehow
  // only covering approved submissions, this would only ever have one
  // key; it doesn't.
  byStatus: Record<string, number>;
  // Found on disk and reattached — patchUploadedAt/patchUploadedById/
  // patchFileSize/patchStoredSlug/patchStoredPath set (attributed to whoever ran this
  // reconcile, since the original uploader/timestamp for these was never
  // preserved anywhere once patchUploadedAt got cleared).
  reattached: number;
  // Genuinely not on disk (a definitive ENOENT) — correctly left alone,
  // this is the honest state for a submission that only ever declared a
  // patch without one actually being uploaded. Full list in `problems`
  // below (outcome: 'genuinely-missing') so each one can actually be
  // looked at, not just counted.
  genuinelyMissing: number;
  // Couldn't get a definitive answer either way — left completely
  // untouched. Full list in `problems` below (outcome: 'inconclusive').
  inconclusive: number;
  // Every genuinely-missing or inconclusive submission, with enough detail
  // to actually track each one down by hand. Reattached ones aren't
  // listed individually — nothing to investigate there.
  problems: ReconcileProblemDetail[];
}

export async function reconcilePatchFiles(actingAdminId: string): Promise<ReconcileResult> {
  const candidates = await prisma.submission.findMany({
    where: {
      patchSha1: { not: null },
      patchType: { not: null },
      patchUploadedAt: null,
    },
    select: {
      id: true,
      patchSha1: true,
      patchType: true,
      patchStoredSlug: true,
      patchStoredPath: true,
      platform: true,
      baseRom: { select: { name: true } },
      hackName: true,
      version: true,
      status: true,
    },
  });

  const byStatus: Record<string, number> = {};
  for (const c of candidates) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;

  let reattached = 0;
  const problems: ReconcileProblemDetail[] = [];

  for (const batch of chunk(candidates, 50)) {
    await Promise.all(
      batch.map(async (c) => {
        const sha1 = (c.patchSha1 as string).toLowerCase();
        const patchType = c.patchType as PatchTypeValue;
        // Same candidate order as the detailed-DAT-reimport reattachment
        // logic (admin/import/route.ts): the location the row itself still
        // remembers (if any), then where an upload would file it TODAY (the
        // folder layout), then the old flat layout — which uses the exact
        // slug the file was originally stored under if we still know it,
        // else one recomputed from the submission's own current
        // name/version. The first one that is definitively there wins.
        const slug = c.patchStoredSlug || buildPatchDisplaySlug(c.hackName, c.version);
        const candidates: StoredPatchRef[] = [];
        if (c.patchStoredPath) candidates.push({ sha1, patchType, storedPath: c.patchStoredPath, storedSlug: slug });
        candidates.push({
          sha1,
          patchType,
          storedPath: buildPatchRelativePath({
            platform: c.platform,
            baseRomName: c.baseRom?.name,
            hackName: c.hackName,
            version: c.version,
            sha1,
            patchType,
          }),
          storedSlug: slug,
        });
        candidates.push({ sha1, patchType, storedPath: null, storedSlug: slug });

        const attemptedPaths: string[] = [];
        let found: { ref: StoredPatchRef; size: number } | null = null;
        let failure: PatchFileCheckResult | null = null;
        for (const ref of candidates) {
          attemptedPaths.push(resolveStoredPath(ref));
          const result = await statPatchFileStrict(ref);
          if (result.status === 'found') {
            found = { ref, size: result.size };
            break;
          }
          // Anything but a definitive "not there" ends the search without
          // acting — a later candidate being absent proves nothing about this one.
          if (result.status === 'error') {
            failure = result;
            break;
          }
        }
        const attemptedPath = attemptedPaths.join('  or  ');

        if (found) {
          await prisma.submission.update({
            where: { id: c.id },
            data: {
              patchUploadedAt: new Date(),
              patchUploadedById: actingAdminId,
              patchFileSize: found.size,
              patchStoredSlug: slug,
              // null when the file was found in the old flat layout — the
              // organize tool (patchOrganize.ts) files it into folders later.
              patchStoredPath: found.ref.storedPath ?? null,
            },
          });
          reattached++;
        } else if (!failure) {
          problems.push({ id: c.id, hackName: c.hackName, version: c.version, status: c.status, outcome: 'genuinely-missing', attemptedPath });
        } else {
          const err = failure.status === 'error' ? failure.error : null;
          const errorMessage = (err as NodeJS.ErrnoException)?.message || String(err);
          problems.push({ id: c.id, hackName: c.hackName, version: c.version, status: c.status, outcome: 'inconclusive', attemptedPath, error: errorMessage });
          console.error(`[patchReconcile] couldn't confirm patch file for submission ${c.id} (${attemptedPath}):`, err);
        }
      })
    );
  }

  const genuinelyMissing = problems.filter((p) => p.outcome === 'genuinely-missing').length;
  const inconclusive = problems.filter((p) => p.outcome === 'inconclusive').length;

  return { checked: candidates.length, byStatus, reattached, genuinelyMissing, inconclusive, problems };
}
