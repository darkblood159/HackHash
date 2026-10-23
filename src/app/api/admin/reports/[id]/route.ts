// src/app/api/admin/reports/[id]/route.ts
//
// PATCH: an admin closes or reopens an issue report.
//   action 'resolve'  — fixed / dealt with
//   action 'dismiss'  — not a real problem / can't act on it
//   action 'reopen'   — put a closed one back in the queue
// `allOnEntry: true` (resolve/dismiss only) applies the same action to every
// OPEN report on the same entry in one go — the usual case when five people
// report the same dead link and the admin has just fixed it.
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { ISSUE_NOTE_MAX } from '@/lib/issueReports';

const ACTIONS = { resolve: 'RESOLVED', dismiss: 'DISMISSED', reopen: 'OPEN' } as const;

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const action = body?.action as keyof typeof ACTIONS;
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
    return NextResponse.json({ error: 'Invalid action' }, { status: 422 });
  }
  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string' || body.note.trim().length > ISSUE_NOTE_MAX) {
      return NextResponse.json({ error: `Note is too long (max ${ISSUE_NOTE_MAX} characters)` }, { status: 422 });
    }
    note = body.note.trim() || null;
  }
  const allOnEntry = body.allOnEntry === true && action !== 'reopen';

  const report = await prisma.issueReport.findUnique({ where: { id: params.id }, select: { id: true, submissionId: true, status: true } });
  if (!report) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const status = ACTIONS[action];
  const closing = status !== 'OPEN';
  const data = closing
    ? { status, resolvedById: session.user.id, resolvedAt: new Date(), resolutionNote: note }
    : { status, resolvedById: null, resolvedAt: null, resolutionNote: null };

  // Only ever touch reports that actually change state, and say how many did.
  const where = allOnEntry
    ? { submissionId: report.submissionId, status: 'OPEN' as const }
    : { id: report.id, status: { not: status } };
  const { count } = await prisma.issueReport.updateMany({ where, data });
  if (count === 0) {
    return NextResponse.json({ error: 'Already ' + status.toLowerCase() }, { status: 409 });
  }

  await prisma.auditLog.create({
    data: {
      action: closing ? (status === 'RESOLVED' ? 'ISSUE_RESOLVED' : 'ISSUE_DISMISSED') : 'ISSUE_REOPENED',
      details: { issueId: report.id, allOnEntry, count, note },
      userId: session.user.id,
      submissionId: report.submissionId,
    },
  });

  return NextResponse.json({ ok: true, updated: count });
}
