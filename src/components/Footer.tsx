// src/components/Footer.tsx
import React from 'react';
import Link from 'next/link';
import { Disc3, Github } from 'lucide-react';

export function Footer() {
  return (
    <footer className="border-t border-border mt-24">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          <div className="col-span-2 md:col-span-1">
            <div className="flex items-center gap-2 mb-3">
              <Disc3 size={18} className="text-phosphor" />
              <span className="font-display font-bold text-sm">Hack<span className="text-phosphor">Hash</span></span>
            </div>
            <p className="text-xs text-text-muted leading-relaxed">
              A community-verified database for ROM hacks, translations, and homebrew preservation.
            </p>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">Database</h4>
            <ul className="space-y-2 text-sm">
              <li><Link href="/entries" className="text-text-muted hover:text-phosphor transition-colors">Browse entries</Link></li>
              <li><Link href="/entries/export" className="text-text-muted hover:text-phosphor transition-colors">Export DAT</Link></li>
              <li><Link href="/search" className="text-text-muted hover:text-phosphor transition-colors">Search hashes</Link></li>
            </ul>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">Community</h4>
            <ul className="space-y-2 text-sm">
              <li><Link href="/submit" className="text-text-muted hover:text-phosphor transition-colors">Submit a hack</Link></li>
              <li><Link href="/submissions" className="text-text-muted hover:text-phosphor transition-colors">Review queue</Link></li>
              <li><Link href="/about/trust" className="text-text-muted hover:text-phosphor transition-colors">Trust system</Link></li>
            </ul>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">Project</h4>
            <ul className="space-y-2 text-sm">
              <li>
                <a href="https://github.com/darkblood159/HackHash" target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-text-muted hover:text-phosphor transition-colors">
                  <Github size={13} /> Source
                </a>
              </li>
              <li><Link href="/about" className="text-text-muted hover:text-phosphor transition-colors">About</Link></li>
            </ul>
          </div>
        </div>

        <div className="mt-10 pt-6 border-t border-border-subtle flex flex-col sm:flex-row justify-between gap-3 text-xs text-text-muted">
          <span>ROM files are never uploaded. Only metadata and hashes are stored.</span>
          <span>Community trust, not anti-cheat.</span>
        </div>
      </div>
    </footer>
  );
}
