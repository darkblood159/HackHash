// src/app/search/page.tsx
import React from 'react';
import { SearchInterface } from '@/components/SearchInterface';

export default function SearchPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-12">
      <span className="text-phosphor text-xs font-mono uppercase tracking-widest">Lookup</span>
      <h1 className="font-display text-3xl font-bold mt-2 mb-2">Search</h1>
      <p className="text-text-secondary mb-8">
        Find by hack name, author, version, or paste a CRC32 / MD5 / SHA-1 hash directly.
      </p>
      <SearchInterface />
    </div>
  );
}
