// src/app/api/submissions/[id]/duplicate/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';

const duplicateSchema = z.object({
  duplicateOfId: z.string().optional(),
  duplicateType: z.enum(['SAME_ROM_DIFFERENT_FILENAME', 'SAME_ROM_DIFFERENT_VERSION', 'DIFFERENT_ROM']),
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

  const submission = await prisma.submission.findUnique({ where: { id: params.id } });
  if (!submission) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const body = await req.json();
  const parsed = duplicateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed' }, { status: 422 });
  }

  const { duplicateOfId, duplicateType, notes } = parsed.data;

  // Verify the duplicate target exists if provided
  if (duplicateOfId) {
    const original = await prisma.submission.findUnique({ where: { id: duplicateOfId } });
    if (!original) {
      return NextResponse.json({ error: 'Referenced submission not found' }, { status: 404 });
    }
  }

  const report = await prisma.duplicateReport.create({
    data: {
      submissionId: params.id,
      duplicateOfId,
      userId: session.user.id,
      duplicateType,
      notes,
    },
    include: {
      user: { select: { id: true, name: true, username: true } },
      original: { select: { id: true, hackName: true } },
    },
  });

  await prisma.auditLog.create({
    data: {
      action: 'DUPLICATE_REPORTED',
      details: { duplicateType, duplicateOfId },
      userId: session.user.id,
      submissionId: params.id,
    },
  });

  return NextResponse.json(report, { status: 201 });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const reports = await prisma.duplicateReport.findMany({
    where: { submissionId: params.id },
    include: {
      user: { select: { id: true, name: true, username: true } },
      original: { select: { id: true, hackName: true, sha1: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json(reports);
}
