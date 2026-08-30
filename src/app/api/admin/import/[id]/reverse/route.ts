// src/app/api/admin/import/[id]/reverse/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const datImport = await prisma.datImport.findUnique({
    where: { id: params.id },
    include: { submissions: { select: { id: true, status: true } } },
  });

  if (!datImport) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (datImport.reversed) {
    return NextResponse.json({ error: 'Already reversed' }, { status: 409 });
  }

  // Soft-reverse, consistent with the rest of the app's "never hard-delete
  // history" approach: submissions get marked REJECTED (so they're still
  // visible/traceable) and their ApprovedEntry is removed (so they drop out
  // of the exported DAT). The DatImport row itself is marked reversed, not
  // deleted.
  try {
    await prisma.$transaction(async (tx) => {
      for (const sub of datImport.submissions) {
        if (sub.status === 'REJECTED') continue;

        await tx.approvedEntry.deleteMany({ where: { submissionId: sub.id } });
        await tx.submission.update({ where: { id: sub.id }, data: { status: 'REJECTED' } });
        await tx.auditLog.create({
          data: {
            action: 'SUBMISSION_REJECTED',
            details: { reason: `Reverted as part of undoing DAT import ${params.id}` },
            userId: session.user.id,
            submissionId: sub.id,
          },
        });
      }

      await tx.datImport.update({
        where: { id: params.id },
        data: { reversed: true, reversedAt: new Date(), reversedById: session.user.id },
      });
    }, { timeout: 30000, maxWait: 10000 });
  } catch (err) {
    console.error('Reverse import failed:', err);
    return NextResponse.json({ error: 'Reverse failed — please try again' }, { status: 500 });
  }

  return NextResponse.json({ message: `Reversed ${datImport.submissions.length} entries` });
}
