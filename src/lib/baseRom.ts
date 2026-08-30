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
