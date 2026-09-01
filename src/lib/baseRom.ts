// src/lib/baseRom.ts
//
// Shared logic for the BaseRom entity (prisma/schema.prisma) — a canonical,
// hash-verified reference to an unpatched source ROM, deduplicated by SHA-1
// and shared across every Submission that uses it. See the schema comment
// above the BaseRom model for the full "why" — this file is deliberately
// small and mirrors the same resolve-or-create shape as
// resolveOrCreateFamily in src/lib/hackFamily.ts, for the same reasons
// (used from both a live API route and the DAT importer, needs the same
// create-race handling either way).

type TxClient = any;

export interface ResolveBaseRomParams {
  platform: string;
  name: string;
  crc32: string;
  md5: string;
  sha1: string;
  submittedById?: string | null;
  // Only used when actually CREATING a new row — an existing match is
  // returned as-is, its status untouched. Defaults to PENDING, since the
  // normal path (a submitter hashing their own copy) always starts there;
  // the DAT importer is the one caller that passes something else, to
  // preserve an already-approved base rom's status across a rebuild.
  status?: 'PENDING' | 'APPROVED' | 'REJECTED';
  approvedById?: string | null;
  approvedAt?: Date | null;
}

export interface ResolvedBaseRom {
  baseRomId: string;
  isNew: boolean;
  name: string;
  status: string;
}

export async function resolveOrCreateBaseRom(
  tx: TxClient,
  params: ResolveBaseRomParams,
  // True only when `tx` is a callback client from an open prisma.$transaction
  // (the bulk importer — see src/app/api/admin/import/route.ts). Defaults to
  // false because the other caller (src/app/api/base-roms/route.ts) passes
  // the plain top-level `prisma` client — see the matching parameter comment
  // on resolveOrCreateFamily in src/lib/hackFamily.ts for why that context
  // doesn't need, and can't use, a savepoint.
  inTransaction = false
): Promise<ResolvedBaseRom> {
  const sha1 = params.sha1.toLowerCase().trim();

  const existing = await tx.baseRom.findUnique({ where: { sha1 } });
  if (existing) {
    return { baseRomId: existing.id, isNew: false, name: existing.name, status: existing.status };
  }

  // See the matching comment in resolveOrCreateFamily (src/lib/hackFamily.ts)
  // — Postgres aborts the whole surrounding transaction on this create's own
  // unique-constraint violation, so the recovery findUniqueOrThrow below
  // would otherwise fail too (25P02, transaction aborted), not just this
  // insert. Same real-world trigger: two versions of one hack that share a
  // base rom (e.g. both patch the same "Pokémon FireRed (USA) (Rev 1)")
  // land in the same import chunk and race to create it.
  if (inTransaction) await tx.$executeRaw`SAVEPOINT resolve_base_rom`;
  try {
    const created = await tx.baseRom.create({
      data: {
        platform: params.platform,
        name: params.name,
        crc32: params.crc32.toLowerCase().trim(),
        md5: params.md5.toLowerCase().trim(),
        sha1,
        status: params.status ?? 'PENDING',
        submittedById: params.submittedById ?? null,
        approvedById: params.approvedById ?? null,
        approvedAt: params.approvedAt ?? null,
      },
    });
    return { baseRomId: created.id, isNew: true, name: created.name, status: created.status };
  } catch (err: any) {
    // Someone else hashed and submitted the exact same base rom in the
    // brief window between the lookup above and this create — use theirs
    // rather than failing.
    if (err?.code === 'P2002') {
      if (inTransaction) await tx.$executeRaw`ROLLBACK TO SAVEPOINT resolve_base_rom`;
      const raceWinner = await tx.baseRom.findUniqueOrThrow({ where: { sha1 } });
      return { baseRomId: raceWinner.id, isNew: false, name: raceWinner.name, status: raceWinner.status };
    }
    throw err;
  }
}

// ─── Reassignment (switching an EXISTING submission's base rom) ───────────────
//
// Two entry points, deliberately NOT funneled through one shared "apply"
// function the way family has (reassignSubmissionFamily) — the two callers
// need genuinely different write shapes, not just different validation:
//
// - The admin/owner direct-edit PATCH route (src/app/api/submissions/[id]/
//   route.ts) folds baseRomId into its OWN already-in-flight updateData
//   object, alongside whatever other fields are being saved in the same
//   request, and applies everything in one tx.submission.update() call —
//   there's no separate "just the base rom" write to isolate there. That
//   route calls validateBaseRomAssignment() directly for validation only,
//   and lets its existing update carry the write.
// - The change-request approval route DOES need a standalone apply step —
//   baseRomId was deliberately pulled out of that route's generic `changes`
//   bag (see EDITABLE_FIELDS in src/app/api/submissions/[id]/change-request/
//   route.ts) specifically so it gets this validation instead of riding
//   along unvalidated. reassignSubmissionBaseRom() below is that standalone
//   step, mirroring reassignSubmissionFamily()'s validate+write+audit-log
//   shape since that's the only caller that needs exactly that shape.
//
// Both share validateBaseRomAssignment() for the actual validation, so the
// platform-match/status rules only exist in one place either way.

export class BaseRomAssignError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface ValidatedBaseRomTarget {
  id: string;
  name: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
}

// Validates a proposed base-rom target against the submission's platform
// and against the base rom's own review status. `client` accepts either
// the plain top-level `prisma` client (eager pre-checks, no transaction
// needed for a read-only check) or a `tx` from an open transaction
// (immediate application) — TxClient is `any` for exactly this reason, see
// its definition above.
//
// PENDING is allowed, not just APPROVED — matching the standard this
// already holds to at submission-creation time (SubmitForm.tsx / this
// file's resolveOrCreateBaseRom: a submitter hashing a genuinely new base
// rom isn't blocked on its review finishing first). REJECTED is the one
// status that's never a valid target — that status means an admin already
// looked at this exact entry and said it's wrong.
export async function validateBaseRomAssignment(
  client: TxClient,
  baseRomId: string,
  submissionPlatform: string
): Promise<ValidatedBaseRomTarget> {
  const target = await client.baseRom.findUnique({ where: { id: baseRomId } });
  if (!target) {
    throw new BaseRomAssignError('That base ROM no longer exists — please pick a different one.', 404);
  }
  if (target.platform !== submissionPlatform) {
    throw new BaseRomAssignError(
      `That base ROM is for ${target.platform}, not ${submissionPlatform} — base ROMs are platform-specific.`,
      422
    );
  }
  if (target.status === 'REJECTED') {
    throw new BaseRomAssignError('That base ROM was rejected and can\'t be used — please pick a different one.', 422);
  }
  return { id: target.id, name: target.name, status: target.status };
}

export interface BaseRomReassignResult {
  changed: boolean;
  targetName: string | null;
}

// Standalone validate + write + audit-log — see the file-section comment
// above for why this exists separately from the admin PATCH route's own
// handling, and isn't shared with it the way reassignSubmissionFamily is
// shared across its three callers.
export async function reassignSubmissionBaseRom(
  tx: TxClient,
  submission: { id: string; baseRomId: string | null; platform: string },
  baseRomId: string,
  actorId: string | null
): Promise<BaseRomReassignResult> {
  if (baseRomId === submission.baseRomId) {
    return { changed: false, targetName: null };
  }

  const target = await validateBaseRomAssignment(tx, baseRomId, submission.platform);

  await tx.submission.update({ where: { id: submission.id }, data: { baseRomId } });

  await tx.auditLog.create({
    data: {
      action: 'SUBMISSION_BASE_ROM_CHANGED',
      details: { by: actorId, from: submission.baseRomId, to: baseRomId, toName: target.name },
      userId: actorId,
      submissionId: submission.id,
    },
  });

  return { changed: true, targetName: target.name };
}
