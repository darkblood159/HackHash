// src/app/api/admin/backup/route.ts
//
// GET  — generates and downloads a full-database backup (see
//        src/lib/fullBackup.ts for exactly what's included/excluded).
// POST — restores one, WIPING every table listed in fullBackup.ts's
//        RESTORE_ORDER first. Destructive and requires an explicit
//        confirm flag — see BackupRestoreForm.tsx for the two-step UI
//        confirmation on top of this server-side check.
//
// Both admin-only, same pattern as every other route under /api/admin.

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { generateFullBackup, restoreFullBackup, FullBackupValidationError } from '@/lib/fullBackup';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const payload = await generateFullBackup({ id: session.user.id, name: session.user.name ?? null });

  const filename = `hackhash-backup-${new Date().toISOString().slice(0, 10)}.json`;
  return new NextResponse(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body was not valid JSON.' }, { status: 400 });
  }

  // Belt-and-suspenders on top of BackupRestoreForm.tsx's own two-step
  // confirmation — this exact string, not just a boolean, so a restore can
  // never fire from a casually-replayed or scripted request that happens to
  // send `confirm: true` without the person having actually read the
  // warning.
  if (body?.confirm !== 'WIPE AND RESTORE') {
    return NextResponse.json(
      { error: 'Missing or incorrect confirmation. This endpoint wipes and replaces the entire database.' },
      { status: 400 }
    );
  }

  try {
    const result = await restoreFullBackup(body.payload);
    return NextResponse.json(result);
  } catch (err: any) {
    if (err instanceof FullBackupValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error('Full backup restore failed:', err);
    return NextResponse.json(
      { error: 'Restore failed — the transaction was rolled back, so the previous data should be intact. ' + (err?.message || 'Unknown error.') },
      { status: 500 }
    );
  }
}
