'use client';

// src/components/ExportCard.tsx
import React from 'react';
import { Download, FileCode, FileJson, FileSpreadsheet, FileStack } from 'lucide-react';

const ICONS = { xml: FileCode, json: FileJson, csv: FileSpreadsheet, detailed: FileStack };

export function ExportCard({
  format,
  title,
  description,
  platform,
}: {
  format: 'xml' | 'json' | 'csv' | 'detailed';
  title: string;
  description: string;
  platform?: string;
}) {
  const Icon = ICONS[format];
  const href = `/api/entries/export?format=${format}${platform ? `&platform=${platform}` : ''}`;

  return (
    <a
      href={href}
      download
      className="flex items-center gap-4 p-5 rounded-lg border border-border bg-bg-surface hover:border-phosphor/40 transition-colors group"
    >
      <div className="w-10 h-10 rounded-lg bg-bg-elevated flex items-center justify-center shrink-0 group-hover:bg-phosphor/10 transition-colors">
        <Icon size={18} className="text-phosphor" />
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="font-medium text-text-primary">{title}</h3>
        <p className="text-xs text-text-muted mt-0.5">{description}</p>
      </div>
      <Download size={16} className="text-text-muted group-hover:text-phosphor transition-colors shrink-0" />
    </a>
  );
}
