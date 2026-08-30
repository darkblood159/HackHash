// src/app/api/submissions/[id]/comment/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';

const commentSchema = z.object({
  content: z.string().min(1).max(2000),
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
  const parsed = commentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid comment' }, { status: 422 });
  }

  const comment = await prisma.comment.create({
    data: {
      submissionId: params.id,
      userId: session.user.id,
      content: parsed.data.content,
    },
    include: {
      user: { select: { id: true, name: true, image: true, role: true } },
    },
  });

  return NextResponse.json(comment, { status: 201 });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const comments = await prisma.comment.findMany({
    where: { submissionId: params.id, isDeleted: false },
    include: { user: { select: { id: true, name: true, image: true, role: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return NextResponse.json(comments);
}
