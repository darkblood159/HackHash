'use client';

// src/components/ExportAllZipCard.tsx
import React from 'react';
import { Archive } from 'lucide-react';

const FORMATS: { format: 'xml' | 'json' | 'csv' | 'detailed'; label: string }[] = [
  { format: 'xml', label: 'XML' },
  { format: 'json', label: 'JSON' },
  { format: 'csv', label: 'CSV' },
  { format: 'detailed', label: 'Detailed' },
];

export function ExportAllZipCard() {
  return (
    <div className="flex items-center gap-4 p-5 rounded-lg border border-phosphor/30 bg-phosphor/5">
      <div className="w-10 h-10 rounded-lg bg-bg-elevated flex items-center justify-center shrink-0">
        <Archive size={18} className="text-phosphor" />
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="font-medium text-text-primary">All platforms, separately (.zip)</h3>
        <p className="text-xs text-text-muted mt-0.5">
          One file per platform in a single download — same as clicking through every platform below, bundled for you.
        </p>
      </div>
      <div className="flex gap-1.5 shrink-0">
        {FORMATS.map(({ format, label }) => (
          <a
            key={format}
            href={`/api/entries/export/zip?format=${format}`}
            download
            className="px-2.5 py-1.5 rounded-md border border-border text-xs font-medium text-text-secondary hover:border-phosphor/40 hover:text-phosphor transition-colors"
          >
            {label}
          </a>
        ))}
      </div>
    </div>
  );
}
