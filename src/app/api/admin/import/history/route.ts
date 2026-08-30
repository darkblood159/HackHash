// src/app/api/admin/import/history/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1'));
  const perPage = 20;

  const [total, imports] = await Promise.all([
    prisma.datImport.count(),
    prisma.datImport.findMany({
      select: {
        id: true, filename: true, fileSizeBytes: true, platform: true, note: true,
        totalParsed: true, importedCount: true, skippedDuplicates: true, errorCount: true,
        reversed: true, reversedAt: true, createdAt: true,
        importedById: true,
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  // Resolve importer names (avoid a relation just for a name lookup)
  const importerIds = Array.from(new Set(imports.map((i) => i.importedById)));
  const importers = await prisma.user.findMany({ where: { id: { in: importerIds } }, select: { id: true, name: true } });
  const importerMap = Object.fromEntries(importers.map((u) => [u.id, u.name]));

  return NextResponse.json({
    items: imports.map((i) => ({ ...i, importedByName: importerMap[i.importedById] ?? 'Unknown' })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  });
}
