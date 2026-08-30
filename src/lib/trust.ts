// src/lib/trust.ts
import { prisma } from './prisma';
import { TrustEventType, SubmissionStatus } from '@prisma/client';
import { TRUST_TIER_THRESHOLDS } from '@/types';

// ─── Weight Calculation ────────────────────────────────────────────────────────

export function getUserWeight(trustScore: number): number {
  if (trustScore >= TRUST_TIER_THRESHOLDS.VETERAN) return 10;
  if (trustScore >= TRUST_TIER_THRESHOLDS.TRUSTED) return 3;
  return 1;
}

export function getTrustTier(trustScore: number): 'new' | 'trusted' | 'veteran' {
  if (trustScore >= TRUST_TIER_THRESHOLDS.VETERAN) return 'veteran';
  if (trustScore >= TRUST_TIER_THRESHOLDS.TRUSTED) return 'trusted';
  return 'new';
}

// ─── Trust Deltas (read from DB settings, with hard-coded defaults) ───────────

const DEFAULT_DELTAS: Record<TrustEventType, number> = {
  SUBMISSION_APPROVED: 10,
  SUBMISSION_REJECTED: -10,
  CORRECT_VERIFICATION: 2,
  FALSE_VERIFICATION: -5,
  DUPLICATE_FOUND: 5,
  SPAM: -20,
  ABUSE: -30,
  ADMIN_ADJUSTMENT: 0,
};

export async function getTrustDelta(eventType: TrustEventType): Promise<number> {
  const key = `trust_${eventType.toLowerCase()}`;
  try {
    const setting = await prisma.siteSetting.findUnique({ where: { key } });
    if (setting) return parseInt(setting.value, 10);
  } catch {}
  return DEFAULT_DELTAS[eventType] ?? 0;
}

// ─── Apply Trust Event ────────────────────────────────────────────────────────

export async function applyTrustEvent({
  userId,
  eventType,
  reason,
  relatedId,
  delta,
}: {
  userId: string;
  eventType: TrustEventType;
  reason: string;
  relatedId?: string;
  delta?: number;
}) {
  const actualDelta = delta ?? (await getTrustDelta(eventType));

  const [trustEvent] = await prisma.$transaction([
    prisma.trustEvent.create({
      data: {
        userId,
        eventType,
        delta: actualDelta,
        reason,
        relatedId,
      },
    }),
    prisma.user.update({
      where: { id: userId },
      data: { trustScore: { increment: actualDelta } },
    }),
  ]);

  return trustEvent;
}

// ─── Verification Score ───────────────────────────────────────────────────────

export async function recalculateVerificationScore(submissionId: string): Promise<number> {
  const verifications = await prisma.verification.findMany({
    where: { submissionId },
    include: { user: { select: { trustScore: true } } },
  });

  const score = verifications.reduce((sum, v) => {
    const weight = getUserWeight(v.user.trustScore);
    return sum + (v.matches ? weight : -weight);
  }, 0);

  await prisma.submission.update({
    where: { id: submissionId },
    data: { verificationScore: score },
  });

  return score;
}

// ─── Status Transitions ────────────────────────────────────────────────────────

export async function getStatusThresholds() {
  const settings = await prisma.siteSetting.findMany({
    where: { key: { in: ['community_verified_threshold', 'recommended_threshold'] } },
  });

  const map = Object.fromEntries(settings.map((s) => [s.key, parseInt(s.value, 10)]));
  return {
    communityVerified: map['community_verified_threshold'] ?? 5,
    recommended: map['recommended_threshold'] ?? 15,
  };
}

export async function updateSubmissionStatus(submissionId: string, score: number) {
  const thresholds = await getStatusThresholds();

  const current = await prisma.submission.findUnique({
    where: { id: submissionId },
    select: { status: true },
  });

  if (!current) return;

  // Don't override terminal states
  const terminalStates: SubmissionStatus[] = ['APPROVED', 'REJECTED'];
  if (terminalStates.includes(current.status)) return;

  let newStatus: SubmissionStatus = 'PENDING';
  if (score < 0) {
    newStatus = 'DISPUTED';
  } else if (score >= thresholds.recommended) {
    newStatus = 'RECOMMENDED';
  } else if (score >= thresholds.communityVerified) {
    newStatus = 'COMMUNITY_VERIFIED';
  }

  if (newStatus !== current.status) {
    await prisma.submission.update({
      where: { id: submissionId },
      data: { status: newStatus },
    });

    await prisma.auditLog.create({
      data: {
        action: 'STATUS_AUTO_UPDATED',
        details: {
          from: current.status,
          to: newStatus,
          score,
        },
        submissionId,
      },
    });
  }
}

// ─── Post-approval: reconcile verifier trust ──────────────────────────────────

export async function reconcileVerifierTrust(
  submissionId: string,
  approved: boolean
) {
  const verifications = await prisma.verification.findMany({
    where: { submissionId },
    select: { userId: true, matches: true },
  });

  for (const v of verifications) {
    const correct = approved ? v.matches : !v.matches;
    await applyTrustEvent({
      userId: v.userId,
      eventType: correct ? 'CORRECT_VERIFICATION' : 'FALSE_VERIFICATION',
      reason: `Verification outcome reconciled for submission ${submissionId}`,
      relatedId: submissionId,
    });
  }
}
