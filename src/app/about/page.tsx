// src/app/about/page.tsx
import React from 'react';
import Link from 'next/link';
import { Lock, Users, GitBranch } from 'lucide-react';

export default function AboutPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-12">
      <span className="text-phosphor text-xs font-mono uppercase tracking-widest">About</span>
      <h1 className="font-display text-3xl font-bold mt-2 mb-6">What this is</h1>

      <div className="prose-sm space-y-5 text-text-secondary leading-relaxed">
        <p>
          HackHash is a community-maintained database of verified checksums for ROM hacks, fan translations,
          homebrew releases, and preservation projects. It works like No-Intro or Redump, but for the much
          messier, much more interesting world of fan-made games.
        </p>

        <p>
          We never ask for your ROM file. Every hash — CRC32, MD5, SHA-1 — is computed locally in your browser
          using the Web Crypto API and JavaScript. Only the resulting fingerprint and metadata you choose to
          share gets submitted.
        </p>

        <h2 className="font-display text-lg font-bold text-text-primary pt-4">Why not just trust the hash?</h2>
        <p>
          Because anyone could submit a fabricated hash. Instead of trying to cryptographically prove honesty —
          which isn't really possible client-side — we lean on the community. Other people who hold the same
          ROM can hash their own copy and confirm a match. Enough independent confirmations, weighted by each
          verifier's track record, moves a submission toward approval.
        </p>

        <p>
          <Link href="/about/trust" className="text-phosphor hover:underline">Read more about the trust system →</Link>
        </p>
      </div>

      <div className="grid sm:grid-cols-3 gap-4 mt-10">
        {[
          { icon: Lock, title: 'No uploads', body: 'ROM files never leave your device.' },
          { icon: Users, title: 'Community verified', body: 'Trust is earned, not assumed.' },
          { icon: GitBranch, title: 'Open DAT', body: 'Export anytime, in any format.' },
        ].map((f) => (
          <div key={f.title} className="p-4 rounded-lg border border-border bg-bg-surface">
            <f.icon size={18} className="text-phosphor mb-2" />
            <h3 className="text-sm font-semibold text-text-primary">{f.title}</h3>
            <p className="text-xs text-text-muted mt-1">{f.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
