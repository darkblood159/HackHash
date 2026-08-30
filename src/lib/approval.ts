// src/lib/approval.ts
//
// Approving a submission touches several tables: ApprovedEntry, Submission,
// TrustEvent (x N verifiers), User.trustScore (x N verifiers), AuditLog. The
// previous implementation did these as separate sequential round-trips, which
// had two real problems: (1) if anything failed partway through — a slow
// connection, a reverse proxy timeout — the submission was left in a
// half-approved state where retrying would immediately fail again with a
// duplicate-key error on the ApprovedEntry it had already half-created, and
// (2) it was just slow (one round trip per verifier). Doing the whole thing
// in a single transaction fixes both: it either fully happens or fully rolls
// back, so a retry after a failure starts from a clean slate every time.

import { TRUST_TIER_THRESHOLDS } from '@/types';
import { pushMappingToHasheous, type HasheousEnv } from '@/lib/hasheous';
import { pullMappingForSubmission, recordAcceptedPushResult } from '@/lib/hasheousSync';
import { prisma } from '@/lib/prisma';

type TxClient = any; // see note in admin submissions route re: typing transaction clients against the stub

// ─── Post-approval Hasheous auto-pull ─────────────────────────────────────────
// Called AFTER the approval transaction commits, same as the push trigger
// below. Runs first (logically) — check whether Hasheous already has this
// hash before proposing our own data — though since neither call is
// awaited by the route, they actually run concurrently in practice, which
// is harmless here (worst case the push runs against slightly stale local
// data from before the pull's upsert completes).
//
// Previously, a newly-approved submission only got Hasheous mapping data
// from the next scheduled auto-pull (up to 6h later) or a manual pull click.
export async function triggerHasheousPullForSubmission(submissionId: string) {
  try {
    const sub = await prisma.submission.findUnique({
      where: { id: submissionId },
      select: { id: true, sha1: true, md5: true, crc32: true, hackName: true, gameMappingId: true },
    });
    if (!sub) return;
    const env = (process.env.HASHEOUS_ENV as HasheousEnv | undefined) ?? 'beta';
    const result = await pullMappingForSubmission(sub, env);
    if (result.error) console.warn(`[hasheous/auto-pull-on-approve] ${sub.hackName}:`, result.error);
    else if (result.found) console.log(`[hasheous/auto-pull-on-approve] ${sub.hackName}: found=${result.found} updated=${result.updated}`);
  } catch (err: any) {
    console.error(`[hasheous/auto-pull-on-approve] error for ${submissionId}:`, err?.message);
  }
}

// ─── Post-approval Hasheous auto-push ─────────────────────────────────────────
// Called AFTER the approval transaction commits. Never inside it — Hasheous is
// an external HTTP call and a failed push must never roll back an approval.
export async function triggerHasheousPushForSubmission(submissionId: string) {
  if (!process.env.HASHEOUS_API_KEY) return;
  try {
    const sub = await prisma.submission.findUnique({
      where: { id: submissionId },
      select: { sha1: true, md5: true, crc32: true, hackName: true, gameMapping: true },
    });
    if (!sub?.gameMapping) return;
    const m = sub.gameMapping as any;
    const hasMappings = [m.igdbId, m.theGamesDBId, m.giantBombId, m.launchboxId, m.screenScraperId, m.steamGridDBId, m.retroAchievementsId, m.gogId, m.epicGamesId].some(Boolean);
    if (!hasMappings) return;
    const env = (process.env.HASHEOUS_ENV as HasheousEnv | undefined) ?? 'beta';
    const sentMappings = {
      igdbId: m.igdbId ?? undefined, theGamesDBId: m.theGamesDBId ?? undefined,
      giantBombId: m.giantBombId ?? undefined, launchboxId: m.launchboxId ?? undefined,
      screenScraperId: m.screenScraperId ?? undefined, steamGridDBId: m.steamGridDBId ?? undefined,
      retroAchievementsId: m.retroAchievementsId ?? undefined,
      gogId: m.gogId ?? undefined, epicGamesId: m.epicGamesId ?? undefined,
    };
    const result = await pushMappingToHasheous({
      hashes: { crc32: sub.crc32, md5: sub.md5, sha1: sub.sha1 },
      mappings: sentMappings,
    }, env);
    if (!result.ok) console.warn(`[hasheous/auto-push] ${sub.hackName}:`, result.error);
    else {
      console.log(`[hasheous/auto-push] pushed ${sub.hackName} — accepted=[${(result.accepted ?? []).join(', ')}]${Object.keys(result.rejected ?? {}).length ? ` rejected=${JSON.stringify(result.rejected)}` : ''}`);
      await recordAcceptedPushResult(m.id, sentMappings, result);
    }
  } catch (err: any) {
    console.error(`[hasheous/auto-push] error for ${submissionId}:`, err?.message);
  }
}

interface ApprovableSubmission {
  id: string;
  hackName: string;
  version: string;
  platform: string;
  filename: string;
  fileSize: bigint;
  crc32: string;
  md5: string;
  sha1: string;
  submittedById: string;
}

const DEFAULT_DELTAS = {
  approved: 10,
  correctVerification: 2,
  falseVerification: -5,
};

// ─── Collision-safe machine naming ────────────────────────────────────────────
//
// Two different Players can patch the exact same file with the exact same
// tool and STILL end up with different output ROMs — wrong base rom used,
// a different (but same-named) release of the patching tool, etc. When that
// happens, both hacks naturally want the exact same DAT machine name
// (ApprovedEntry.machineName has a hard @@unique constraint) — without this,
// the second one either throws a raw P2002 on approval, or, worse, silently
// kills an AUTO-approval outright: auto-approval has no admin in the loop to
// notice a collision and manually retype a different name the way the
// approval menu's "Machine name" field already lets one do today.
//
// Resolution: if the desired name is already taken by a DIFFERENT entry,
// append a short disambiguating tag built from the submission's own MD5 —
// first 7 hex characters, lowercase, git-short-hash style. Lowercase
// specifically (not the upper-case CRC32 convention tools like IGIR use)
// because that's the casing RetroAchievements' own hash lookups and
// "Supported Game Hashes" pages use — RA is the metadata source most likely
// to actually key off this exact hash. Deliberately reactive, not applied to
// every entry: the vast majority of names never collide with anything, and
// a name nobody's disputing should stay exactly as typed.
//
// This ONLY ever touches ApprovedEntry.machineName/description — never
// Submission.hackName. Every public-facing display (the <h1> on a
// submission's page, the homepage feed, /entries, search results) reads
// from hackName/HackFamily.name specifically so this tag can never surface
// there; it only ever appears in the "DAT entry" card on a submission's own
// page and inside actual exported DAT files — exactly where someone
// cross-referencing a specific downloaded file, or a ROM-management tool,
// would already be looking.
export async function resolveMachineName(
  tx: TxClient,
  desiredName: string,
  ownMd5: string,
  excludeSubmissionId?: string
): Promise<string> {
  const collision = await tx.approvedEntry.findUnique({ where: { machineName: desiredName } });
  if (!collision || collision.submissionId === excludeSubmissionId) {
    return desiredName;
  }
  return `${desiredName} [${ownMd5.toLowerCase().slice(0, 7)}]`;
}

export async function performApprovalInTx(
  tx: TxClient,
  submission: ApprovableSubmission,
  options: {
    machineName?: string;
    approvedById: string;
    auditAction: string;
    auditDetails?: Record<string, unknown>;
  }
): Promise<string> {
  const desiredName = options.machineName ?? `${submission.hackName} (v${submission.version})`;
  const name = await resolveMachineName(tx, desiredName, submission.md5);

  await tx.approvedEntry.create({
    data: {
      submissionId: submission.id,
      machineName: name,
      description: name,
      romName: submission.filename,
      platform: submission.platform,
      fileSize: submission.fileSize,
      crc32: submission.crc32,
      md5: submission.md5,
      sha1: submission.sha1,
      approvedById: options.approvedById,
    },
  });

  await tx.submission.update({
    where: { id: submission.id },
    data: { status: 'APPROVED' },
  });

  // Resolve trust point values once (admin-configurable via SiteSetting, with defaults)
  const settings = await tx.siteSetting.findMany({
    where: { key: { in: ['trust_submission_approved', 'trust_correct_verification', 'trust_false_verification'] } },
  });
  const settingsMap = Object.fromEntries(settings.map((s: any) => [s.key, parseInt(s.value, 10)]));
  const approvedDelta = settingsMap['trust_submission_approved'] ?? DEFAULT_DELTAS.approved;
  const correctDelta = settingsMap['trust_correct_verification'] ?? DEFAULT_DELTAS.correctVerification;
  const falseDelta = settingsMap['trust_false_verification'] ?? DEFAULT_DELTAS.falseVerification;

  // Reward the submitter
  await tx.trustEvent.create({
    data: {
      userId: submission.submittedById,
      eventType: 'SUBMISSION_APPROVED',
      delta: approvedDelta,
      reason: `Submission "${submission.hackName}" approved`,
      relatedId: submission.id,
    },
  });
  await tx.user.update({
    where: { id: submission.submittedById },
    data: { trustScore: { increment: approvedDelta } },
  });

  // Reconcile every verifier (hash-based and manual-vote alike) against the outcome
  const verifications = await tx.verification.findMany({
    where: { submissionId: submission.id },
    select: { userId: true, matches: true },
  });

  for (const v of verifications) {
    const correct = v.matches; // approved === true, so "matches"/yes votes were correct
    const eventType = correct ? 'CORRECT_VERIFICATION' : 'FALSE_VERIFICATION';
    const delta = correct ? correctDelta : falseDelta;

    await tx.trustEvent.create({
      data: {
        userId: v.userId,
        eventType,
        delta,
        reason: `Verification outcome reconciled for submission ${submission.id}`,
        relatedId: submission.id,
      },
    });
    await tx.user.update({
      where: { id: v.userId },
      data: { trustScore: { increment: delta } },
    });
  }

  await tx.auditLog.create({
    data: {
      action: options.auditAction,
      details: { machineName: name, ...options.auditDetails },
      userId: options.approvedById,
      submissionId: submission.id,
    },
  });

  return name;
}

// ─── Auto-approval trigger rules ───────────────────────────────────────────────
//
// These run after a new Verification row is created (see the verify route).
// They're independent of the existing weighted verificationScore / status
// ladder (Pending → Community Verified → Recommended) — that ladder still
// exists for admins to triage with; these are hard auto-approve shortcuts:
//
//  1. A single hash-match from a Veteran verifier approves immediately —
//     veterans get the benefit of the doubt alone.
//  2. Two hash-matches, at least one from a Trusted-or-above verifier,
//     approves. A lone Trusted match is deliberately NOT enough by itself —
//     it still needs one more confirming match from anyone before it's
//     considered settled, which was the bug: a single Trusted vote used to
//     instant-approve the same as a Veteran one.
//  3. Three hash-matches from anyone (no Trusted/Veteran involved) approves —
//     this is the fallback for submissions verified entirely by newer users.
//  4. Manual votes (cast by Verifiers, Administrators, or Veteran-tier users
//     who don't have the file to hash) need 2 "yes" votes to approve — but
//     each "no" vote raises the bar by one more required "yes": 1 no needs
//     3 yes, 2 no needs 4 yes, etc.

export const TRUSTED_THRESHOLD = TRUST_TIER_THRESHOLDS.TRUSTED;
export const VETERAN_THRESHOLD = TRUST_TIER_THRESHOLDS.VETERAN;

// Manual votes are for users vouching without the file in hand. Eligibility
// is Verifier role, Administrator role, or Veteran trust tier — deliberately
// NOT just "Trusted" trust tier, since that tier doesn't require any
// role-based vetting, only points.
export function canCastManualVote(role: string, trustScore: number): boolean {
  return role === 'VERIFIER' || role === 'ADMINISTRATOR' || trustScore >= VETERAN_THRESHOLD;
}

export function getRequiredManualYesVotes(noCount: number): number {
  return 2 + noCount;
}

export async function checkAutoApproval(
  tx: TxClient,
  submissionId: string
): Promise<{ shouldApprove: boolean; reason?: string; details?: Record<string, unknown> }> {
  const verifications = await tx.verification.findMany({
    where: { submissionId },
    select: { matches: true, isManualVote: true, user: { select: { trustScore: true } } },
  });

  const hashMatches = verifications.filter((v: any) => !v.isManualVote && v.matches);
  const hasVeteranMatch = hashMatches.some((v: any) => v.user.trustScore >= VETERAN_THRESHOLD);
  const hasTrustedMatch = hashMatches.some((v: any) => v.user.trustScore >= TRUSTED_THRESHOLD);

  if (hasVeteranMatch) {
    return { shouldApprove: true, reason: 'AUTO_APPROVED_VETERAN_MATCH', details: { trigger: 'veteran_hash_match' } };
  }

  if (hasTrustedMatch && hashMatches.length >= 2) {
    return {
      shouldApprove: true,
      reason: 'AUTO_APPROVED_TRUSTED_MATCHES',
      details: { trigger: 'trusted_hash_matches', count: hashMatches.length },
    };
  }

  if (hashMatches.length >= 3) {
    return { shouldApprove: true, reason: 'AUTO_APPROVED_THREE_MATCHES', details: { trigger: 'three_contributor_matches', count: hashMatches.length } };
  }

  const manualVotes = verifications.filter((v: any) => v.isManualVote);
  const yesCount = manualVotes.filter((v: any) => v.matches).length;
  const noCount = manualVotes.filter((v: any) => !v.matches).length;
  const required = getRequiredManualYesVotes(noCount);

  if (yesCount >= required) {
    return { shouldApprove: true, reason: 'AUTO_APPROVED_MANUAL_VOTES', details: { trigger: 'manual_votes', yesCount, noCount, required } };
  }

  return { shouldApprove: false };
}
