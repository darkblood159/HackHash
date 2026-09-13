// src/app/api/submissions/[id]/formats/[formatId]/route.ts
//
// Removes an alternate-format entry. Two people can do this: an admin, at
// any time (cleaning up a wrong or spammy entry); or the person who added
// it, but only while it's still PENDING (a self-serve "oops, wrong hash"
// undo before anyone's reviewed it — same shape as being able to delete
// your own not-yet-acted-on Verification). Once it's been reviewed either
// way, only an admin can remove it — an approved entry shouldn't quietly
// vanish at the original submitter's own whim, and a rejected one is
// useful history for anyone wondering why a hash doesn't match.
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; formatId: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }

  const entry = await prisma.alternateFormat.findUnique({ where: { id: params.formatId } });
  if (!entry || entry.submissionId !== params.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const isAdmin = session.user.role === 'ADMINISTRATOR';
  const isOwnPendingEntry = entry.addedById === session.user.id && entry.status === 'PENDING';
  if (!isAdmin && !isOwnPendingEntry) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await prisma.alternateFormat.delete({ where: { id: entry.id } });

  await prisma.auditLog.create({
    data: {
      action: 'ALTERNATE_FORMAT_REMOVED',
      details: { format: entry.format, filename: entry.filename, sha1: entry.sha1 },
      userId: session.user.id,
      submissionId: params.id,
    },
  });

  return NextResponse.json({ ok: true });
}
