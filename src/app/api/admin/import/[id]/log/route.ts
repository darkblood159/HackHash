// src/app/api/admin/import/[id]/log/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

function csvEscape(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const datImport = await prisma.datImport.findUnique({
    where: { id: params.id },
    include: {
      submissions: {
        select: { hackName: true, version: true, sha1: true, md5: true, crc32: true, status: true },
      },
    },
  });

  if (!datImport) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const rows: string[] = ['Result,Name,Version,SHA1,MD5,CRC32,Reason'];

  for (const s of datImport.submissions) {
    rows.push([
      datImport.reversed ? 'Reversed' : 'Imported',
      s.hackName, s.version, s.sha1, s.md5, s.crc32, '',
    ].map(csvEscape).join(','));
  }

  const skippedLog = Array.isArray(datImport.skippedLog) ? (datImport.skippedLog as any[]) : [];
  for (const s of skippedLog) {
    rows.push([
      'Skipped', s.machineName ?? '', '', s.sha1 ?? '', '', '', s.reason ?? '',
    ].map(csvEscape).join(','));
  }

  const csv = rows.join('\n');
  const safeFilename = datImport.filename.replace(/[^a-z0-9.\-_]/gi, '_');

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="import-log-${safeFilename}-${datImport.id}.csv"`,
    },
  });
}
