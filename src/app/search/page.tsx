// src/app/search/page.tsx
import React from 'react';
import { SearchInterface } from '@/components/SearchInterface';

export default function SearchPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-12">
      <span className="text-phosphor text-xs font-mono uppercase tracking-widest">Lookup</span>
      <h1 className="font-display text-3xl font-bold mt-2 mb-2">Search</h1>
      <p className="text-text-secondary mb-8">
        Find a hack by name, author, or hash — or switch to Base ROM to find hacks that need a ROM you already have. Drop the ROM file in directly and it's hashed and searched automatically.
      </p>
      <SearchInterface />
    </div>
  );
}
