// src/app/api/admin/comments/[id]/route.ts
//
// Admin-only removal of a single comment from a submission's discussion.
// Soft delete (isDeleted: true) — matches Comment.isDeleted, which already
// existed in the schema but had no write path anywhere before this. Kept
// soft rather than a real prisma.comment.delete() to match this project's
// standing default (Submission's own deletedAt/deletedById works the same
// way) and because there's no technical forcing function toward a hard
// delete here the way there was for BaseRom's sha1 uniqueness — nothing
// about Comment's shape makes a soft-deleted row problematic to leave
// around. Both GET /api/submissions/[id]/comment and the submission detail
// page's own direct query already filter on isDeleted: false, so a removed
// comment disappears from the discussion immediately with no other changes
// needed anywhere.
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const comment = await prisma.comment.findUnique({ where: { id: params.id } });
  if (!comment || comment.isDeleted) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  await prisma.comment.update({
    where: { id: params.id },
    data: { isDeleted: true },
  });

  // Identity + a content snippet captured into the audit log itself (same
  // reasoning as BASE_ROM_REMOVED) rather than relying on any column on the
  // row — AuditLog.details is a plain Json field, so this is fully readable
  // even though the comment now reads as deleted everywhere else. Tagged
  // with submissionId so this shows up in that submission's own Audit
  // trail panel, right next to where the moderation actually happened —
  // that panel already renders any action generically (log.action with
  // underscores swapped for spaces), so no display-side change is needed
  // for this to appear correctly there.
  await prisma.auditLog.create({
    data: {
      action: 'COMMENT_DELETED',
      details: {
        commentId: comment.id,
        authorUserId: comment.userId,
        contentSnippet: comment.content.slice(0, 200),
      },
      userId: session.user.id,
      submissionId: comment.submissionId,
    },
  });

  return NextResponse.json({ ok: true });
}
