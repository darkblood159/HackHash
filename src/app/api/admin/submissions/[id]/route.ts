// src/app/api/admin/submissions/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { performApprovalInTx, triggerHasheousPushForSubmission, triggerHasheousPullForSubmission } from '@/lib/approval';
import { z } from 'zod';

const actionSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT', 'DISPUTE']),
  reason: z.string().max(1000).optional(),
  // For approve: override machine name
  machineName: z.string().max(300).optional(),
});

// Generous explicit timeout for the approve transaction — it loops over every
// verifier on the submission, and the default Prisma interactive-transaction
// timeout (5s) was plausibly what caused the "had to refresh 3 times" bug
// under reverse-proxy latency: a transaction timing out rolls back cleanly
// now (atomic), but it used to partially apply before the atomicity fix.
const TRANSACTION_OPTS = { timeout: 20000, maxWait: 10000 };

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const submission = await prisma.submission.findUnique({
    where: { id: params.id },
    include: { submittedBy: { select: { id: true } } },
  });

  if (!submission) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (['APPROVED', 'REJECTED'].includes(submission.status)) {
    return NextResponse.json({ error: 'Already in terminal state' }, { status: 409 });
  }

  const body = await req.json();
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid action' }, { status: 422 });
  }

  const { action, reason, machineName } = parsed.data;

  if (action === 'APPROVE') {
    try {
      const name = await prisma.$transaction(async (tx) => {
        // Re-check status inside the transaction: if two admins click approve
        // around the same time, or this is a retry of a request whose
        // response got lost, this guard makes the retry a clean no-op error
        // instead of a duplicate-key crash.
        const fresh = await tx.submission.findUnique({ where: { id: params.id }, select: { status: true } });
        if (!fresh || fresh.status === 'APPROVED' || fresh.status === 'REJECTED') {
          throw Object.assign(new Error('Already in a terminal state'), { httpStatus: 409 });
        }

        return performApprovalInTx(tx, submission, {
          machineName,
          approvedById: session.user.id,
          auditAction: 'SUBMISSION_APPROVED',
          auditDetails: { approvedBy: session.user.id, reason },
        });
      }, TRANSACTION_OPTS);

      // Fire-and-forget — neither blocks the response. Pull checks whether
      // Hasheous already has this hash (previously only happened on the next
      // scheduled auto-pull, up to 6h later, or a manual click); push then
      // proposes whatever mapping data we have of our own.
      void triggerHasheousPullForSubmission(params.id);
      void triggerHasheousPushForSubmission(params.id);

      return NextResponse.json({ message: 'Approved', machineName: name });
    } catch (err: any) {
      if (err?.httpStatus === 409) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      console.error('Approve failed:', err);
      return NextResponse.json({ error: 'Approve failed — please try again' }, { status: 500 });
    }
  }

  if (action === 'REJECT') {
    try {
      await prisma.$transaction(async (tx) => {
        const fresh = await tx.submission.findUnique({ where: { id: params.id }, select: { status: true } });
        if (!fresh || fresh.status === 'APPROVED' || fresh.status === 'REJECTED') {
          throw Object.assign(new Error('Already in a terminal state'), { httpStatus: 409 });
        }

        await tx.submission.update({ where: { id: params.id }, data: { status: 'REJECTED' } });

        const settings = await tx.siteSetting.findMany({
          where: { key: { in: ['trust_submission_rejected', 'trust_correct_verification', 'trust_false_verification'] } },
        });
        const settingsMap = Object.fromEntries(settings.map((s: any) => [s.key, parseInt(s.value, 10)]));
        const rejectedDelta = settingsMap['trust_submission_rejected'] ?? -10;
        const correctDelta = settingsMap['trust_correct_verification'] ?? 2;
        const falseDelta = settingsMap['trust_false_verification'] ?? -5;

        await tx.trustEvent.create({
          data: {
            userId: submission.submittedById,
            eventType: 'SUBMISSION_REJECTED',
            delta: rejectedDelta,
            reason: reason ?? `Submission "${submission.hackName}" rejected`,
            relatedId: submission.id,
          },
        });
        await tx.user.update({ where: { id: submission.submittedById }, data: { trustScore: { increment: rejectedDelta } } });

        const verifications = await tx.verification.findMany({
          where: { submissionId: submission.id },
          select: { userId: true, matches: true },
        });
        for (const v of verifications) {
          // approved === false, so a "no match" / "no" vote was the correct call
          const correct = !v.matches;
          const eventType = correct ? 'CORRECT_VERIFICATION' : 'FALSE_VERIFICATION';
          const delta = correct ? correctDelta : falseDelta;
          await tx.trustEvent.create({
            data: { userId: v.userId, eventType, delta, reason: `Verification outcome reconciled for submission ${submission.id}`, relatedId: submission.id },
          });
          await tx.user.update({ where: { id: v.userId }, data: { trustScore: { increment: delta } } });
        }

        await tx.auditLog.create({
          data: {
            action: 'SUBMISSION_REJECTED',
            details: { rejectedBy: session.user.id, reason },
            userId: session.user.id,
            submissionId: params.id,
          },
        });
      }, TRANSACTION_OPTS);

      return NextResponse.json({ message: 'Rejected' });
    } catch (err: any) {
      if (err?.httpStatus === 409) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      console.error('Reject failed:', err);
      return NextResponse.json({ error: 'Reject failed — please try again' }, { status: 500 });
    }
  }

  if (action === 'DISPUTE') {
    await prisma.submission.update({
      where: { id: params.id },
      data: { status: 'DISPUTED' },
    });

    await prisma.auditLog.create({
      data: {
        action: 'SUBMISSION_DISPUTED',
        details: { by: session.user.id, reason },
        userId: session.user.id,
        submissionId: params.id,
      },
    });

    return NextResponse.json({ message: 'Marked as disputed' });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
