// src/app/api/admin/submission-batches/[id]/reject/route.ts
//
// Withdraws a whole bulk-submit batch in one step — the undo for "the wrong
// base ROM got picked once and applied to every row" (see SubmissionBatch in
// prisma/schema.prisma). Modeled on the DAT-import reverse endpoint: a SOFT
// reverse. Rows are marked REJECTED (still visible and traceable, never
// deleted) and the batch is marked reversed, which also stops anything more
// being added to it (loadOpenBatch refuses a reversed batch).
//
// Only PENDING rows are touched. A row that has already been approved by the
// community is left exactly as it is — it earned that through verification,
// and one person's batch being withdrawn shouldn't silently undo it; an admin
// can still reject an individual approved row the normal way. No trust
// penalty is applied: the usual SUBMISSION_REJECTED deduction is meant for a
// reviewer's judgement on a submission, whereas this is typically undoing a
// shared mistake, and multiplying the penalty by the batch size would be
// punitive. An admin who is withdrawing a genuinely abusive batch can adjust
// trust (or ban) separately.
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const batch = await prisma.submissionBatch.findUnique({
    where: { id: params.id },
    include: { submissions: { select: { id: true, status: true } } },
  });
  if (!batch) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (batch.reversed) return NextResponse.json({ error: 'Already withdrawn' }, { status: 409 });

  const pending = batch.submissions.filter((s) => s.status === 'PENDING');
  const left = batch.submissions.length - pending.length;

  try {
    await prisma.$transaction(
      async (tx) => {
        for (const sub of pending) {
          await tx.submission.update({ where: { id: sub.id }, data: { status: 'REJECTED' } });
          await tx.auditLog.create({
            data: {
              action: 'SUBMISSION_REJECTED',
              details: { reason: `Withdrawn as part of bulk batch ${batch.id}`, batchId: batch.id },
              userId: session.user.id,
              submissionId: sub.id,
            },
          });
        }
        await tx.submissionBatch.update({
          where: { id: batch.id },
          data: { reversed: true, reversedAt: new Date(), reversedById: session.user.id },
        });
        await tx.auditLog.create({
          data: {
            action: 'BULK_BATCH_WITHDRAWN',
            details: { batchId: batch.id, rejected: pending.length, leftAlone: left },
            userId: session.user.id,
          },
        });
      },
      { timeout: 30000, maxWait: 10000 }
    );
  } catch (err) {
    console.error('Withdraw batch failed:', err);
    return NextResponse.json({ error: 'Withdraw failed — please try again' }, { status: 500 });
  }

  return NextResponse.json({
    message: `Rejected ${pending.length} pending ${pending.length === 1 ? 'entry' : 'entries'}${left ? `; left ${left} already-decided ${left === 1 ? 'entry' : 'entries'} alone` : ''}.`,
    rejected: pending.length,
    leftAlone: left,
  });
}
