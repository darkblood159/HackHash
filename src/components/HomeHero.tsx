'use client';

// src/components/HomeHero.tsx
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Lock } from 'lucide-react';
import { ROMProcessor } from './ROMProcessor';

interface Stats {
  approvedCount: number;
  submissionCount: number;
  userCount: number;
}

function HexRain() {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    const chars = '0123456789abcdef';
    const gen = () =>
      Array.from({ length: 16 }, () =>
        Array.from({ length: 2 }, () => chars[Math.floor(Math.random() * 16)]).join('')
      ).join(' ');
    setLines(Array.from({ length: 14 }, gen));

    const interval = setInterval(() => {
      setLines((prev) => {
        const next = [...prev];
        const idx = Math.floor(Math.random() * next.length);
        next[idx] = gen();
        return next;
      });
    }, 400);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="absolute inset-0 overflow-hidden opacity-[0.07] select-none pointer-events-none" aria-hidden>
      <div className="font-mono text-xs leading-6 text-phosphor whitespace-pre">
        {lines.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
    </div>
  );
}

function StatTicker({ stats }: { stats: Stats }) {
  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
      {[
        { label: 'Approved entries', value: stats.approvedCount },
        { label: 'Submissions tracked', value: stats.submissionCount },
        { label: 'Contributors', value: stats.userCount },
      ].map((s) => (
        <div key={s.label} className="flex items-baseline gap-2">
          <span className="font-display font-bold text-2xl text-phosphor font-numeric">{s.value.toLocaleString()}</span>
          <span className="text-xs text-text-muted uppercase tracking-wider">{s.label}</span>
        </div>
      ))}
    </div>
  );
}

export function HomeHero({ stats }: { stats: Stats }) {
  return (
    <section className="relative border-b border-border-subtle overflow-hidden">
      <div className="absolute inset-0">
        <HexRain />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-bg-base/60 to-bg-base" />
      </div>

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 pt-16 pb-20">
        <div className="grid lg:grid-cols-5 gap-12 items-start">
          {/* Left: copy */}
          <div className="lg:col-span-2 space-y-6">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-phosphor/30 bg-phosphor/5 text-phosphor text-xs font-mono">
              <Lock size={11} />
              Zero ROM uploads, ever
            </div>

            <h1 className="font-display text-4xl sm:text-5xl font-bold leading-[1.05] tracking-tight">
              Preserve ROM hacks<br />
              <span className="text-phosphor">without the upload.</span>
            </h1>

            <p className="text-text-secondary text-base leading-relaxed max-w-md">
              Hash a hack in your browser, submit the fingerprint, and let the community verify it.
              A No-Intro-style DAT built on trust, not anti-cheat.
            </p>

            <div className="flex flex-wrap gap-3 pt-2">
              <Link
                href="/submit"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md bg-phosphor text-bg-base font-medium text-sm hover:bg-phosphor-bright shadow-phosphor-sm hover:shadow-phosphor transition-all"
              >
                Submit a hack
                <ArrowRight size={15} />
              </Link>
              <Link
                href="/entries"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md border border-border text-text-primary font-medium text-sm hover:border-phosphor/50 hover:text-phosphor transition-colors"
              >
                Browse database
              </Link>
            </div>

            <div className="pt-6 border-t border-border-subtle">
              <StatTicker stats={stats} />
            </div>
          </div>

          {/* Right: live demo */}
          <div className="lg:col-span-3">
            <div className="mb-3 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-phosphor animate-pulse-phosphor" />
              <span className="text-xs font-mono text-text-muted uppercase tracking-widest">Try it — nothing leaves this tab</span>
            </div>
            <ROMProcessor showUseButton={false} />
          </div>
        </div>
      </div>
    </section>
  );
}
