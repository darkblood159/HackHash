// src/app/api/users/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const user = await prisma.user.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      name: true,
      image: true,
      username: true,
      bio: true,
      role: true,
      trustScore: true,
      isBanned: true,
      createdAt: true,
      _count: { select: { submissions: true, verifications: true } },
      trustEvents: {
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, eventType: true, delta: true, reason: true, createdAt: true },
      },
      submissions: {
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true, hackName: true, version: true, status: true,
          verificationScore: true, createdAt: true,
        },
      },
      verifications: {
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true, matches: true, weight: true, createdAt: true,
          submission: { select: { id: true, hackName: true, status: true } },
        },
      },
    },
  });

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  if (user.isBanned) {
    return NextResponse.json({
      id: user.id,
      name: '[Banned User]',
      image: null,
      username: null,
      role: user.role,
      trustScore: user.trustScore,
      isBanned: true,
      createdAt: user.createdAt,
    });
  }

  return NextResponse.json(user);
}
