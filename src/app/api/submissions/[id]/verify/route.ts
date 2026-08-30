// src/app/api/submissions/[id]/verify/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { recalculateVerificationScore, updateSubmissionStatus, getUserWeight } from '@/lib/trust';
import { performApprovalInTx, checkAutoApproval, canCastManualVote, VETERAN_THRESHOLD, triggerHasheousPushForSubmission, triggerHasheousPullForSubmission } from '@/lib/approval';
import { z } from 'zod';

const verifySchema = z.object({
  matches: z.boolean(),
  isManualVote: z.boolean().optional(),
  sha1Matched: z.boolean().optional(),
  md5Matched: z.boolean().optional(),
  crc32Matched: z.boolean().optional(),
  notes: z.string().max(1000).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (session.user.isBanned) {
    return NextResponse.json({ error: 'Your account has been banned' }, { status: 403 });
  }

  const submission = await prisma.submission.findUnique({
    where: { id: params.id },
  });

  if (!submission) {
    return NextResponse.json({ error: 'Submission not found' }, { status: 404 });
  }

  // Cannot verify your own submission
  if (submission.submittedById === session.user.id) {
    return NextResponse.json({ error: 'Cannot verify your own submission' }, { status: 403 });
  }

  // Cannot verify approved/rejected submissions
  if (['APPROVED', 'REJECTED'].includes(submission.status)) {
    return NextResponse.json({ error: 'Submission is already in a terminal state' }, { status: 409 });
  }

  // Check if already verified by this user
  const existing = await prisma.verification.findUnique({
    where: { submissionId_userId: { submissionId: params.id, userId: session.user.id } },
  });

  if (existing) {
    return NextResponse.json({ error: 'You have already verified this submission' }, { status: 409 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = verifySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 });
  }

  const data = parsed.data;

  // Get the user's current trust score and role to calculate weight and check eligibility
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { trustScore: true, role: true },
  });
  const trustScore = user?.trustScore ?? 0;

  // Manual votes ("I don't have the file, but I'm vouching based on review")
  // are restricted to Verifiers, Administrators, and Veteran-tier users —
  // enforced here, not just hidden in the UI.
  if (data.isManualVote && !canCastManualVote(user?.role ?? 'GUEST', trustScore)) {
    return NextResponse.json(
      { error: `Manual votes require the Verifier role, Administrator role, or Veteran trust tier (${VETERAN_THRESHOLD}+)` },
      { status: 403 }
    );
  }

  const weight = getUserWeight(trustScore);
  let autoApproved: { name: string; reason?: string } | null = null;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.verification.create({
        data: {
          submissionId: params.id,
          userId: session.user.id,
          matches: data.matches,
          isManualVote: data.isManualVote ?? false,
          sha1Matched: data.sha1Matched,
          md5Matched: data.md5Matched,
          crc32Matched: data.crc32Matched,
          notes: data.notes,
          weight,
        },
      });

      await tx.auditLog.create({
        data: {
          action: data.isManualVote ? 'SUBMISSION_MANUAL_VOTE' : 'SUBMISSION_VERIFIED',
          details: { matches: data.matches, weight, isManualVote: data.isManualVote ?? false },
          userId: session.user.id,
          submissionId: params.id,
        },
      });

      const autoApproval = await checkAutoApproval(tx, params.id);
      if (autoApproval.shouldApprove) {
        const name = await performApprovalInTx(tx, submission, {
          approvedById: session.user.id,
          auditAction: autoApproval.reason ?? 'AUTO_APPROVED',
          auditDetails: autoApproval.details,
        });
        autoApproved = { name, reason: autoApproval.reason };
      }
    }, { timeout: 20000, maxWait: 10000 });
  } catch (err) {
    console.error('Verify failed:', err);
    return NextResponse.json({ error: 'Verification failed — please try again' }, { status: 500 });
  }

  // If auto-approval didn't fire, fall through to the existing weighted-score
  // ladder (Pending → Community Verified → Recommended) for admin triage.
  let newScore: number | null = null;
  if (!autoApproved) {
    newScore = await recalculateVerificationScore(params.id);
    await updateSubmissionStatus(params.id, newScore);
  } else {
    // Auto-approval happened — check Hasheous for an existing match, then
    // push whatever mapping data we have, both in the background. This was
    // the actual gap: auto-approval (the common case — most approvals
    // happen this way, not via an admin manually clicking Approve) only
    // ever triggered the push half, never the pull half, so a freshly
    // auto-approved submission had to wait for the next scheduled auto-pull
    // (up to 6h) to get any Hasheous data at all.
    void triggerHasheousPullForSubmission(params.id);
    void triggerHasheousPushForSubmission(params.id);
  }

  return NextResponse.json({ newScore, autoApproved }, { status: 201 });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const verification = await prisma.verification.findUnique({
    where: { submissionId_userId: { submissionId: params.id, userId: session.user.id } },
  });

  if (!verification) {
    return NextResponse.json({ error: 'Verification not found' }, { status: 404 });
  }

  await prisma.verification.delete({
    where: { submissionId_userId: { submissionId: params.id, userId: session.user.id } },
  });

  const newScore = await recalculateVerificationScore(params.id);
  await updateSubmissionStatus(params.id, newScore);

  return NextResponse.json({ message: 'Verification removed', newScore });
}
