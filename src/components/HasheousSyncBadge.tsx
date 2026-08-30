// src/components/HasheousSyncBadge.tsx
// Server-Component-safe — pure display.
//
// Logo setup (one-time, done on the server):
//   curl https://hasheous.org/images/logo.svg > public/hasheous-logo.svg
// Once that file exists, the badge shows the real Hasheous logo. If it
// doesn't exist yet, it gracefully falls back to a generic database icon.

import React from 'react';
import Image from 'next/image';
import { ExternalLink } from 'lucide-react';
import { getHasheousGameUrl, type HasheousEnv } from '@/lib/hasheous';
import fs from 'fs';
import path from 'path';

interface HasheousSyncBadgeProps {
  hasheousId?: string | null;
  hasheousEnv?: string | null;
  hasheousSyncedAt?: Date | string | null;
}

// Check once at module load time whether the logo file exists
const logoExists = (() => {
  try {
    return fs.existsSync(path.join(process.cwd(), 'public', 'hasheous-logo.svg'));
  } catch {
    return false;
  }
})();

export function HasheousSyncBadge({ hasheousId, hasheousEnv, hasheousSyncedAt }: HasheousSyncBadgeProps) {
  if (!hasheousId) return null;

  const env = (hasheousEnv === 'production' ? 'production' : 'beta') as HasheousEnv;
  const href = getHasheousGameUrl(hasheousId, env);

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={hasheousSyncedAt ? `Synced with Hasheous on ${new Date(hasheousSyncedAt).toLocaleDateString()}` : 'Synced with Hasheous'}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-medium hover:bg-emerald-500/20 transition-colors group"
    >
      {logoExists ? (
        <Image
          src="/hasheous-logo.svg"
          alt="Hasheous"
          width={14}
          height={14}
          className="opacity-80 group-hover:opacity-100"
        />
      ) : (
        // Fallback until the logo file is placed in /public
        <span className="w-3.5 h-3.5 rounded-sm bg-emerald-500/40 text-[8px] font-bold flex items-center justify-center text-emerald-300">H</span>
      )}
      Synced with Hasheous
      <ExternalLink size={9} className="opacity-0 group-hover:opacity-100 transition-opacity" />
    </a>
  );
}
