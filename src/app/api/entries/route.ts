// src/app/api/entries/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1'));
  const perPage = Math.min(100, Math.max(1, parseInt(searchParams.get('perPage') ?? '25')));
  const search = searchParams.get('q');
  const platform = searchParams.get('platform');

  const where: Record<string, unknown> = search
    ? {
        submission: { deletedAt: null },
        OR: [
          { machineName: { contains: search, mode: 'insensitive' as const } },
          { sha1: { contains: search, mode: 'insensitive' as const } },
          { md5: { contains: search, mode: 'insensitive' as const } },
          { crc32: { contains: search, mode: 'insensitive' as const } },
          { submission: { author: { contains: search, mode: 'insensitive' as const } } },
        ],
      }
    : { submission: { deletedAt: null } };

  if (platform) {
    where.platform = platform;
  }

  const [total, entries] = await Promise.all([
    prisma.approvedEntry.count({ where }),
    prisma.approvedEntry.findMany({
      where,
      include: {
        submission: {
          select: {
            id: true, hackName: true, author: true, releaseYear: true, releaseDate: true,
            submittedBy: { select: { name: true, username: true } },
            tags: { include: { tag: true } },
          },
        },
      },
      orderBy: { machineName: 'asc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  return NextResponse.json({
    items: entries.map((e) => ({ ...e, fileSize: e.fileSize.toString() })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  });
}
