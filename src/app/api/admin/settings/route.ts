// src/app/api/admin/settings/route.ts
//
// Small, admin-only settings surface — currently just the one patch-
// uploads kill switch (src/lib/siteSettings.ts). Follows the same
// GET-list/POST-action shape as src/app/api/admin/users/route.ts: GET
// returns current state, POST validates a body with zod and applies one
// change, logging an AuditLog entry the same way every other admin
// mutation in this project already does. A dedicated /admin/settings page
// is the one place in the UI that calls this — see that page for why a
// self-service toggle was worth building instead of leaving this as a
// direct-DB-only SiteSetting row (the ask was "whenever I need to",
// without a redeploy or a manual DB edit each time).
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { arePatchUploadsDisabled, setPatchUploadsDisabled } from '@/lib/siteSettings';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return NextResponse.json({ patchUploadsDisabled: await arePatchUploadsDisabled() });
}

const updateSettingsSchema = z.object({
  patchUploadsDisabled: z.boolean(),
});

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = updateSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed' }, { status: 422 });
  }

  const { patchUploadsDisabled } = parsed.data;
  await setPatchUploadsDisabled(patchUploadsDisabled, session.user.id);
  await prisma.auditLog.create({
    data: {
      action: patchUploadsDisabled ? 'PATCH_UPLOADS_DISABLED' : 'PATCH_UPLOADS_ENABLED',
      details: { patchUploadsDisabled },
      userId: session.user.id,
    },
  });

  return NextResponse.json({ patchUploadsDisabled });
}
