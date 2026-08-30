// src/app/admin/import/page.tsx
import React from 'react';
import { ImportDatForm } from '@/components/ImportDatForm';
import { prisma } from '@/lib/prisma';
import { PlatformBadge } from '@/components/ui/PlatformBadge';
import { ReverseImportButton } from '@/components/ReverseImportButton';
import { Download } from 'lucide-react';
import { format } from 'date-fns';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

function formatBytes(bytes?: number | null): string {
  if (!bytes) return '—';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

async function getHistory() {
  const imports = await prisma.datImport.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  const importerIds = Array.from(new Set(imports.map((i) => i.importedById)));
  const importers = await prisma.user.findMany({ where: { id: { in: importerIds } }, select: { id: true, name: true } });
  const importerMap = Object.fromEntries(importers.map((u) => [u.id, u.name]));
  return imports.map((i) => ({ ...i, importedByName: importerMap[i.importedById] ?? 'Unknown' }));
}

export default async function AdminImportPage() {
  const history = await getHistory().catch(() => []);

  return (
    <div className="space-y-12">
      <div>
        <div className="mb-8">
          <h1 className="font-display text-2xl font-bold">Import a DAT file</h1>
          <p className="text-text-secondary text-sm mt-1 max-w-2xl">
            Bring in entries from an existing DAT (Logiqx XML or this site's own JSON export). Each
            entry is parsed in your browser, then created already-approved — these are treated as
            pre-verified, not run through the community review queue. Pick the platform the whole
            file belongs to, since standard DATs are one file per system.
          </p>
        </div>
        <ImportDatForm />
      </div>

      <div>
        <h2 className="font-display text-lg font-bold mb-4">Import history</h2>

        {history.length === 0 && (
          <p className="text-sm text-text-muted py-8 text-center border border-dashed border-border rounded-lg">
            No imports yet.
          </p>
        )}

        <div className="space-y-2">
          {history.map((h) => (
            <div key={h.id} className="p-4 rounded-lg border border-border bg-bg-surface">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-text-primary text-sm truncate">{h.filename}</span>
                    <PlatformBadge platform={h.platform} size="sm" />
                    {h.reversed && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-rejected-bg text-status-rejected">Reversed</span>
                    )}
                  </div>
                  <p className="text-xs text-text-muted mt-1">
                    {format(new Date(h.createdAt), 'MMM d, yyyy · h:mm a')} by {h.importedByName} · {formatBytes(h.fileSizeBytes)}
                  </p>
                  {h.note && <p className="text-xs text-text-muted mt-1 italic">{h.note}</p>}
                </div>

                <div className="flex items-center gap-4 shrink-0">
                  <div className="text-right text-xs">
                    <p className="text-status-approved font-numeric">{h.importedCount} imported</p>
                    {(h.skippedDuplicates > 0 || h.errorCount > 0) && (
                      <p className="text-text-muted font-numeric">
                        {h.skippedDuplicates} dup · {h.errorCount} failed
                      </p>
                    )}
                  </div>
                  <Link
                    href={`/api/admin/import/${h.id}/log`}
                    className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-border text-text-muted hover:border-phosphor/40 hover:text-phosphor transition-colors"
                  >
                    <Download size={11} /> Log
                  </Link>
                  {!h.reversed && h.importedCount > 0 && (
                    <ReverseImportButton importId={h.id} entryCount={h.importedCount} />
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
