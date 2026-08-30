// src/app/page.tsx
import React from 'react';
import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { ArrowRight, GitBranch, Users, Database, ShieldCheck } from 'lucide-react';
import { HomeHero } from '@/components/HomeHero';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { PlatformBadge } from '@/components/ui/PlatformBadge';
import { Avatar } from '@/components/ui/Avatar';
import { formatDistanceToNow } from 'date-fns';

export const dynamic = 'force-dynamic';

async function getStats() {
  const [approvedCount, submissionCount, userCount, recentApproved, recentSubmissions] = await Promise.all([
    prisma.approvedEntry.count({ where: { submission: { deletedAt: null } } }),
    prisma.submission.count({ where: { deletedAt: null } }),
    prisma.user.count({ where: { role: { not: 'GUEST' } } }),
    prisma.approvedEntry.findMany({
      where: { submission: { deletedAt: null } },
      take: 6,
      orderBy: { approvedAt: 'desc' },
      include: { submission: { select: { author: true, hackName: true } } },
    }),
    prisma.submission.findMany({
      take: 5,
      where: { status: { in: ['PENDING', 'COMMUNITY_VERIFIED', 'RECOMMENDED'] }, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: { submittedBy: { select: { name: true, image: true, username: true } } },
    }),
  ]);

  return { approvedCount, submissionCount, userCount, recentApproved, recentSubmissions };
}

export default async function HomePage() {
  const stats = await getStats().catch(() => ({
    approvedCount: 0,
    submissionCount: 0,
    userCount: 0,
    recentApproved: [],
    recentSubmissions: [],
  }));

  return (
    <div>
      <HomeHero stats={stats} />

      {/* How it works */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 py-20 border-t border-border-subtle">
        <div className="mb-12">
          <span className="text-phosphor text-xs font-mono uppercase tracking-widest">Process</span>
          <h2 className="font-display text-2xl sm:text-3xl font-bold mt-2">From local hash to verified entry</h2>
        </div>

        <div className="grid md:grid-cols-4 gap-px bg-border-subtle rounded-xl overflow-hidden">
          {[
            { icon: Database, title: 'Hash locally', body: 'Drop a ROM in your browser. CRC32, MD5, and SHA-1 are computed client-side — the file itself never uploads.' },
            { icon: GitBranch, title: 'Submit metadata', body: 'Attach hack name, author, version, and source. Only the generated hashes and details are sent.' },
            { icon: Users, title: 'Community verifies', body: 'Other holders of the same ROM confirm matching hashes. Trust-weighted votes build a verification score.' },
            { icon: ShieldCheck, title: 'Admin approves', body: 'Once thresholds are met, an administrator merges the entry into the master DAT for export.' },
          ].map((step, i) => (
            <div key={step.title} className="bg-bg-surface p-6">
              <span className="text-text-muted font-mono text-xs">0{i + 1}</span>
              <step.icon size={20} className="text-phosphor mt-3 mb-3" />
              <h3 className="font-display font-semibold text-text-primary mb-1.5">{step.title}</h3>
              <p className="text-sm text-text-secondary leading-relaxed">{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Recent activity */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 py-20 border-t border-border-subtle">
        <div className="grid lg:grid-cols-2 gap-12">
          {/* Recently approved */}
          <div>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-display text-xl font-bold">Recently approved</h2>
              <Link href="/entries" className="text-xs text-phosphor flex items-center gap-1 hover:gap-2 transition-all">
                View database <ArrowRight size={12} />
              </Link>
            </div>
            <div className="space-y-2">
              {stats.recentApproved.length === 0 && (
                <p className="text-sm text-text-muted py-8 text-center border border-dashed border-border rounded-lg">
                  No approved entries yet — be the first to submit.
                </p>
              )}
              {stats.recentApproved.map((entry) => (
                <Link
                  key={entry.id}
                  href={`/submissions/${entry.submissionId}`}
                  className="flex items-center justify-between gap-4 p-3 rounded-lg border border-border bg-bg-surface hover:border-phosphor/30 transition-colors group"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-sm text-text-primary truncate group-hover:text-phosphor transition-colors">
                      {entry.submission.hackName}
                    </p>
                    <p className="text-xs text-text-muted truncate">{entry.submission.author ? `by ${entry.submission.author}` : 'Author unknown'}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <PlatformBadge platform={entry.platform} size="sm" />
                    <span className="font-mono text-xs text-text-muted">{entry.sha1.slice(0, 8)}</span>
                  </div>
                </Link>
              ))}
            </div>
          </div>

          {/* Needs verification */}
          <div>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-display text-xl font-bold">Needs verification</h2>
              <Link href="/submissions" className="text-xs text-phosphor flex items-center gap-1 hover:gap-2 transition-all">
                View queue <ArrowRight size={12} />
              </Link>
            </div>
            <div className="space-y-2">
              {stats.recentSubmissions.length === 0 && (
                <p className="text-sm text-text-muted py-8 text-center border border-dashed border-border rounded-lg">
                  Queue is empty. Nice work, everyone.
                </p>
              )}
              {stats.recentSubmissions.map((sub) => (
                <Link
                  key={sub.id}
                  href={`/submissions/${sub.id}`}
                  className="flex items-center gap-3 p-3 rounded-lg border border-border bg-bg-surface hover:border-phosphor/30 transition-colors group"
                >
                  <Avatar src={sub.submittedBy.image} name={sub.submittedBy.name} size={28} />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm text-text-primary truncate group-hover:text-phosphor transition-colors">
                      {sub.hackName} <span className="text-text-muted font-normal">v{sub.version}</span>
                    </p>
                    <p className="text-xs text-text-muted">
                      {formatDistanceToNow(new Date(sub.createdAt), { addSuffix: true })}
                    </p>
                  </div>
                  <PlatformBadge platform={sub.platform} size="sm" />
                  <StatusBadge status={sub.status} size="sm" />
                </Link>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
