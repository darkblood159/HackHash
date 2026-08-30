// src/app/api/entries/export/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getApprovedEntries, getDetailedApprovedEntries, getDATHeader, generateDATXML, generateDATJSON, generateDetailedJSON, generateDATCSV, buildExportFilenameBase, extensionForFormat } from '@/lib/dat-generator';
import { prisma } from '@/lib/prisma';
import { getDismissedPairsForExport } from '@/lib/hackFamily';

// This is a fully public, read-only, unauthenticated endpoint by design — the
// master DAT is meant to be redistributed. CORS is wide open here on purpose
// so other sites/tools can fetch it directly from browser-side JS, not just
// server-to-server (which never needed CORS in the first place).
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const format = searchParams.get('format') ?? 'xml';
  const platform = searchParams.get('platform') ?? undefined;

  if (!['xml', 'json', 'csv', 'detailed'].includes(format)) {
    return NextResponse.json({ error: 'Invalid format. Use: xml, json, csv, detailed' }, { status: 400, headers: CORS_HEADERS });
  }

  const header = await getDATHeader(platform);
  // e.g. "SNES - RomHacks - HackHash - 2026-07-09 1847.dat"
  const format4 = format as 'xml' | 'json' | 'csv' | 'detailed';
  const filename = `${buildExportFilenameBase(platform, format4)}.${extensionForFormat(format4)}`;

  if (format === 'detailed') {
    const [entries, dismissedDuplicates] = await Promise.all([
      getDetailedApprovedEntries(platform),
      getDismissedPairsForExport(prisma, platform),
    ]);
    const json = generateDetailedJSON(header, entries, dismissedDuplicates);
    return new NextResponse(json, {
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'public, max-age=300',
      },
    });
  }

  const entries = await getApprovedEntries(platform);

  if (format === 'xml') {
    const xml = generateDATXML(header, entries);
    return new NextResponse(xml, {
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'public, max-age=300',
      },
    });
  }

  if (format === 'json') {
    const json = generateDATJSON(header, entries);
    return new NextResponse(json, {
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'public, max-age=300',
      },
    });
  }

  // format === 'csv' — the only remaining valid option after the check above
  const csv = generateDATCSV(entries);
  return new NextResponse(csv, {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'public, max-age=300',
    },
  });
}
