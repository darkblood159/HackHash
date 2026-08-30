// src/app/api/admin/hasheous/status/route.ts
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getHasheousBaseUrl } from '@/lib/hasheous';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return NextResponse.json({
    apiKeyConfigured: !!process.env.HASHEOUS_API_KEY,
    env: process.env.HASHEOUS_ENV ?? 'beta',
    betaUrl: getHasheousBaseUrl('beta'),
    productionUrl: getHasheousBaseUrl('production'),
  });
}
