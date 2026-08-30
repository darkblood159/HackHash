// src/app/api/admin/submissions/[id]/family/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { reassignSubmissionFamily, FamilyReassignError } from '@/lib/hackFamily';

const bodySchema = z.object({
  hackFamilyId: z.string().nullable(),
});

// POST /api/admin/submissions/[id]/family
//
// Moves a SINGLE submission into a different existing HackFamily, or
// detaches it entirely (hackFamilyId: null) — distinct from POST
// /api/admin/hack-families/merge, which moves EVERY submission out of one
// family into another. Used from three places: the approval-menu picker
// (AdminActions.tsx, for a submission about to be approved), AdminEditPanel
// .tsx's direct edit (for a submission at any status, including
// already-approved), and the change-request approval route applies the
// same underlying helper directly (it's already inside its own
// transaction, so it calls reassignSubmissionFamily() itself rather than
// hitting this route over HTTP). The actual validation/move/cleanup/
// audit-log logic lives in reassignSubmissionFamily() (src/lib/
// hackFamily.ts) specifically so all these call sites stay in lockstep —
// see that function's comment.
export async function POST(
  req: NextRequest,
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

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 422 });
  }

  try {
    const result = await prisma.$transaction((tx) =>
      reassignSubmissionFamily(tx, submission, parsed.data.hackFamilyId, session.user.id)
    );
    if (!result.changed) {
      return NextResponse.json({ message: 'No change' });
    }
    return NextResponse.json({ message: result.targetName ? `Moved into "${result.targetName}"` : 'Removed from its family' });
  } catch (err) {
    if (err instanceof FamilyReassignError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
