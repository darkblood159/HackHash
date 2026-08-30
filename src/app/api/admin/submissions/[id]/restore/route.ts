// src/app/api/admin/submissions/[id]/restore/route.ts
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

  const submission = await prisma.submission.findUnique({ where: { id: params.id } });
  if (!submission) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (!submission.deletedAt) {
    return NextResponse.json({ error: 'Not deleted' }, { status: 409 });
  }

  await prisma.submission.update({
    where: { id: params.id },
    data: { deletedAt: null, deletedById: null },
  });

  await prisma.auditLog.create({
    data: {
      action: 'SUBMISSION_RESTORED',
      details: { reason: 'Admin action' },
      userId: session.user.id,
      submissionId: params.id,
    },
  });

  return NextResponse.json({ message: 'Submission restored' });
}
