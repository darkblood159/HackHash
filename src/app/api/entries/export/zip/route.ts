// src/app/api/entries/export/zip/route.ts
//
// Bundles a separate export file per platform into one .zip — the "download
// everything at once" option, since the existing /api/entries/export route
// only ever produces ONE file (either combined-across-all-platforms, or
// scoped to a single platform via ?platform=). This route loops over every
// platform that actually has at least one approved entry (skipping empty
// ones — no point shipping a near-empty file for a console nobody's
// submitted anything for yet) and reuses the exact same generator functions
// the single-file route uses, so the content of each file inside the zip is
// byte-for-byte identical to what you'd get downloading that platform
// individually.
import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';
import { prisma } from '@/lib/prisma';
import {
  getApprovedEntries, getDetailedApprovedEntries, getDATHeader,
  generateDATXML, generateDATJSON, generateDetailedJSON, generateDATCSV,
  buildExportFilenameBase, extensionForFormat,
} from '@/lib/dat-generator';
import { getDismissedPairsForExport } from '@/lib/hackFamily';

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

  if (!['xml', 'json', 'csv', 'detailed'].includes(format)) {
    return NextResponse.json({ error: 'Invalid format. Use: xml, json, csv, detailed' }, { status: 400, headers: CORS_HEADERS });
  }

  const platformRows = await prisma.approvedEntry.findMany({
    where: { submission: { deletedAt: null } },
    select: { platform: true },
    distinct: ['platform'],
    orderBy: { platform: 'asc' },
  });
  const platforms = platformRows.map((r) => r.platform);

  if (platforms.length === 0) {
    return NextResponse.json({ error: 'No approved entries to export yet.' }, { status: 404, headers: CORS_HEADERS });
  }

  const zip = new JSZip();
  const ext = extensionForFormat(format as 'xml' | 'json' | 'csv' | 'detailed');
  // One timestamp for the whole batch — every file inside the zip, and the
  // zip's own filename, should agree on when this export was generated
  // rather than each drifting slightly as the loop below runs.
  const generatedAt = new Date();
  const fileNames: string[] = [];

  for (const platform of platforms) {
    const header = await getDATHeader(platform);
    let content: string;

    if (format === 'detailed') {
      const [entries, dismissedDuplicates] = await Promise.all([
        getDetailedApprovedEntries(platform),
        getDismissedPairsForExport(prisma, platform),
      ]);
      content = generateDetailedJSON(header, entries, dismissedDuplicates);
    } else {
      const entries = await getApprovedEntries(platform);
      content = format === 'xml' ? generateDATXML(header, entries)
        : format === 'json' ? generateDATJSON(header, entries)
        : generateDATCSV(entries);
    }

    // e.g. "SNES - RomHacks - HackHash - 2026-07-09 1847.dat"
    const filename = `${buildExportFilenameBase(platform, format as 'xml' | 'json' | 'csv' | 'detailed', generatedAt)}.${ext}`;
    fileNames.push(filename);
    zip.file(filename, content);
  }

  zip.file(
    'README.txt',
    `HackHash — all platforms, ${format.toUpperCase()} format\n` +
    `Generated ${generatedAt.toISOString()}\n\n` +
    `One file per platform, ${platforms.length} total:\n` +
    fileNames.map((f) => `  - ${f}`).join('\n') +
    `\n\nEach file is identical to downloading that platform individually from the export page.\n`
  );

  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  // e.g. "All Platforms - RomHacks - HackHash - 2026-07-09 1847.zip"
  const zipFilename = `${buildExportFilenameBase(undefined, format as 'xml' | 'json' | 'csv' | 'detailed', generatedAt)}.zip`;

  // TypeScript's BodyInit type and Uint8Array/Buffer's generic typing don't
  // line up cleanly with this project's exact TypeScript/@types/node
  // versions (a known ecosystem inconsistency, not a real runtime gap —
  // Response has always accepted a byte array as its body; two prior
  // attempts using Buffer and then a plain Uint8Array both hit slightly
  // different versions of the same type-checker mismatch). Asserted
  // directly rather than continuing to guess at whichever concrete type
  // happens to satisfy this exact version combination.
  return new NextResponse(bytes as unknown as BodyInit, {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipFilename}"`,
      'Cache-Control': 'public, max-age=300',
    },
  });
}
