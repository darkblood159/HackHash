// src/app/api/submissions/[id]/formats/route.ts
//
// Registers an alternate compressed/container format of an ALREADY-APPROVED
// submission's file — see the AlternateFormat model's own comment in
// prisma/schema.prisma for the full "why" and what this can and can't
// prove on its own. Gated on the submission being APPROVED (not deleted)
// deliberately: while a submission is still PENDING, its own hashes aren't
// settled yet, so anchoring an "alternate format of this" claim to it is
// premature — once it's in the DAT, that's the stable, confirmed content
// an alternate format can meaningfully claim to also represent.
//
// Open to any signed-in, non-banned user (same bar as leaving a comment or
// casting a hash-check verification) — the independence guarantee comes
// from review (see the sibling .../review route), not from gatekeeping who
// can propose one, exactly the same shape as the main submission itself
// (anyone can submit; a DIFFERENT person verifies).
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';

const addFormatSchema = z.object({
  format: z.string().trim().min(1, 'A format label is required').max(50),
  filename: z.string().min(1).max(500),
  fileSize: z.number().int().positive(),
  crc32: z.string().regex(/^[0-9a-f]{8}$/i, 'CRC32 must be 8 hex characters'),
  md5: z.string().regex(/^[0-9a-f]{32}$/i, 'MD5 must be 32 hex characters'),
  sha1: z.string().regex(/^[0-9a-f]{40}$/i, 'SHA-1 must be 40 hex characters'),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }
  if (session.user.isBanned) {
    return NextResponse.json({ error: 'Your account has been banned' }, { status: 403 });
  }

  const submission = await prisma.submission.findUnique({
    where: { id: params.id },
    select: { id: true, status: true, deletedAt: true, sha1: true },
  });
  if (!submission || submission.deletedAt) {
    return NextResponse.json({ error: 'Submission not found' }, { status: 404 });
  }
  if (submission.status !== 'APPROVED') {
    return NextResponse.json(
      { error: 'Alternate formats can only be added once this submission is approved' },
      { status: 409 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = addFormatSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 });
  }

  const sha1 = parsed.data.sha1.toLowerCase();
  const md5 = parsed.data.md5.toLowerCase();
  const crc32 = parsed.data.crc32.toLowerCase();

  // Identical to the original file already on record — nothing to
  // register (this is exactly what "the original format" already means
  // for this submission, see the model comment).
  if (sha1 === submission.sha1) {
    return NextResponse.json(
      { error: 'That hash matches the original submission exactly — no need to add it as a separate format' },
      { status: 409 }
    );
  }

  const existing = await prisma.alternateFormat.findUnique({
    where: { submissionId_sha1: { submissionId: submission.id, sha1 } },
    select: { id: true, format: true, status: true },
  });
  if (existing) {
    return NextResponse.json(
      {
        error: `That exact file is already registered here as ${existing.format} (${existing.status.toLowerCase()})`,
        existing,
      },
      { status: 409 }
    );
  }

  const created = await prisma.alternateFormat.create({
    data: {
      submissionId: submission.id,
      format: parsed.data.format,
      filename: parsed.data.filename,
      fileSize: BigInt(parsed.data.fileSize),
      crc32,
      md5,
      sha1,
      addedById: session.user.id,
    },
  });

  await prisma.auditLog.create({
    data: {
      action: 'ALTERNATE_FORMAT_ADDED',
      details: { alternateFormatId: created.id, format: created.format, filename: created.filename },
      userId: session.user.id,
      submissionId: submission.id,
    },
  });

  return NextResponse.json({
    ...created,
    fileSize: created.fileSize.toString(),
  }, { status: 201 });
}
