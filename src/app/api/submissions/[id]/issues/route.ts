// src/app/api/submissions/[id]/issues/route.ts
//
// POST: a signed-in user reports a problem with an entry ("Report issue" button
// on the entry page — it replaced the old Report-as-duplicate button). Admins
// see every OPEN report in /admin/reports and as a count in the admin nav.
// Validation (which kinds of issue exist, comment rules, pasting an entry URL
// for "duplicate of") lives in src/lib/issueReports.ts.
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { checkReportRateLimit, rateLimitedResponse } from '@/lib/rateLimit';
import { validateIssueInput } from '@/lib/issueReports';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (session.user.isBanned) {
    return NextResponse.json({ error: 'Your account has been banned' }, { status: 403 });
  }

  const limit = await checkReportRateLimit(session.user.id);
  if (!limit.success) {
    return rateLimitedResponse(limit);
  }

  // A soft-deleted entry no longer exists as far as a regular user can tell.
  const submission = await prisma.submission.findUnique({ where: { id: params.id }, select: { id: true, deletedAt: true } });
  if (!submission || submission.deletedAt) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const parsed = validateIssueInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 422 });
  }
  const { type, comment, duplicateOfId } = parsed.data;

  if (duplicateOfId) {
    if (duplicateOfId === params.id) {
      return NextResponse.json({ error: 'An entry can’t be a duplicate of itself' }, { status: 422 });
    }
    const original = await prisma.submission.findUnique({ where: { id: duplicateOfId }, select: { id: true, deletedAt: true } });
    if (!original || original.deletedAt) {
      return NextResponse.json({ error: 'We couldn’t find that entry — check the link or ID, or leave it blank' }, { status: 404 });
    }
  }

  // One OPEN report per person, entry and kind: a second click while an admin
  // hasn't looked yet adds nothing but queue noise. Once an admin has dealt
  // with it, the person can report again (the problem may have come back).
  const existing = await prisma.issueReport.findFirst({
    where: { submissionId: params.id, userId: session.user.id, type, status: 'OPEN' },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json({ error: 'You’ve already reported this — an admin hasn’t reviewed it yet.' }, { status: 409 });
  }

  const report = await prisma.issueReport.create({
    data: { submissionId: params.id, userId: session.user.id, type, comment, duplicateOfId },
    select: { id: true, type: true, status: true, createdAt: true },
  });

  await prisma.auditLog.create({
    data: {
      action: 'ISSUE_REPORTED',
      details: { issueId: report.id, type, hasComment: !!comment, duplicateOfId },
      userId: session.user.id,
      submissionId: params.id,
    },
  });

  return NextResponse.json(report, { status: 201 });
}
