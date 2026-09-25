// src/app/api/admin/patches/reconcile/route.ts
//
// POST — re-checks every submission that DECLARES a patch but isn't
// currently marked as having one uploaded, against real patch storage, and
// reattaches any that are genuinely there. See src/lib/patchReconcile.ts
// for the full reasoning — built to repair the specific incident described
// there, but safe and useful to run any time.

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { reconcilePatchFiles } from '@/lib/patchReconcile';

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const result = await reconcilePatchFiles(session.user.id);
  return NextResponse.json(result);
}
