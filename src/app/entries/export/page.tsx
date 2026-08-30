// src/app/entries/export/page.tsx
import React from 'react';
import { prisma } from '@/lib/prisma';
import { ExportCard } from '@/components/ExportCard';
import { ExportAllZipCard } from '@/components/ExportAllZipCard';
import { PlatformFilters } from '@/components/PlatformFilters';
import { PLATFORMS, PLATFORM_LABELS } from '@/types';

export const dynamic = 'force-dynamic';

export default async function ExportPage({ searchParams }: { searchParams: { platform?: string } }) {
  const platform = searchParams.platform && (PLATFORMS as readonly string[]).includes(searchParams.platform)
    ? searchParams.platform
    : undefined;

  const count = await prisma.approvedEntry.count({
    where: { submission: { deletedAt: null }, ...(platform ? { platform: platform as any } : {}) },
  });

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-12">
      <span className="text-phosphor text-xs font-mono uppercase tracking-widest">Export</span>
      <h1 className="font-display text-3xl font-bold mt-2 mb-2">Download the DAT</h1>
      <p className="text-text-secondary mb-6">
        {count.toLocaleString()} approved {platform ? `${PLATFORM_LABELS[platform as keyof typeof PLATFORM_LABELS]} ` : ''}
        entries, generated fresh on every request. Compatible with No-Intro-style ROM managers
        that read Logiqx DAT XML.
      </p>

      <div className="mb-8">
        <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
          Scope — like No-Intro, one DAT per system
        </p>
        <PlatformFilters current={platform} />
      </div>

      <div className="grid gap-4">
        {!platform && <ExportAllZipCard />}
        <ExportCard
          format="xml"
          title="DAT XML"
          description="Logiqx-compatible format — works with RomVault, ClrMamePro, and most ROM managers."
          platform={platform}
        />
        <ExportCard
          format="json"
          title="JSON"
          description="Structured data for scripts, tools, and custom integrations."
          platform={platform}
        />
        <ExportCard
          format="csv"
          title="CSV"
          description="Flat spreadsheet format for quick browsing in Excel or Sheets."
          platform={platform}
        />
        <ExportCard
          format="detailed"
          title="Detailed export"
          description="Everything the database tracks per hack — author, tags, patch details, notes, and game-database links — not just what's needed for hash verification."
          platform={platform}
        />
      </div>
    </div>
  );
}
