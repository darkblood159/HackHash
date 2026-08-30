// src/app/api/submissions/check-duplicate/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// GET /api/submissions/check-duplicate?sha1={sha1}
// Called by the submit form immediately after a ROM is hashed, before the
// user has even filled in the metadata — gives them early warning that this
// ROM is already in the database, so they're not surprised after spending
// time filling in the form.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sha1 = searchParams.get('sha1')?.toLowerCase();

  if (!sha1 || !/^[0-9a-f]{40}$/.test(sha1)) {
    return NextResponse.json({ duplicate: null });
  }

  const existing = await prisma.submission.findFirst({
    where: { sha1, status: { not: 'REJECTED' } },
    select: {
      id: true,
      hackName: true,
      version: true,
      status: true,
      platform: true,
      submittedBy: { select: { name: true } },
    },
  });

  return NextResponse.json({ duplicate: existing ?? null });
}
