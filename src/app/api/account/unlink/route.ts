// src/app/api/account/unlink/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';

const bodySchema = z.object({
  provider: z.enum(['github', 'discord']),
});

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const account = await prisma.account.findFirst({
    where: { userId: session.user.id, provider: body.provider },
  });
  if (!account) {
    return NextResponse.json({ error: 'That provider is not connected to your account' }, { status: 404 });
  }

  // The one real guard here: never leave a user with zero ways to sign
  // back in. Counting rather than trusting the client's own state, since
  // the client-side check is only ever a UI convenience, not something
  // this route should rely on for correctness.
  const totalAccounts = await prisma.account.count({ where: { userId: session.user.id } });
  if (totalAccounts <= 1) {
    return NextResponse.json(
      { error: "Can't disconnect your only sign-in method — connect another one first" },
      { status: 400 }
    );
  }

  await prisma.account.delete({ where: { id: account.id } });

  await prisma.auditLog.create({
    data: {
      action: 'ACCOUNT_UNLINKED',
      details: { userId: session.user.id, provider: body.provider },
      userId: session.user.id,
    },
  });

  return NextResponse.json({ success: true });
}
