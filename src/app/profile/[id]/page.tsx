// src/app/profile/[id]/page.tsx
import React from 'react';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { Avatar } from '@/components/ui/Avatar';
import { TrustBadge, getTrustTier } from '@/components/ui/TrustBadge';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { format, formatDistanceToNow } from 'date-fns';
import Link from 'next/link';
import { CheckCircle2, XCircle, TrendingUp, TrendingDown } from 'lucide-react';

export const dynamic = 'force-dynamic';

const EVENT_LABELS: Record<string, string> = {
  SUBMISSION_APPROVED: 'Submission approved',
  SUBMISSION_REJECTED: 'Submission rejected',
  CORRECT_VERIFICATION: 'Correct verification',
  FALSE_VERIFICATION: 'False verification',
  DUPLICATE_FOUND: 'Duplicate found',
  SPAM: 'Spam flagged',
  ABUSE: 'Abuse flagged',
  ADMIN_ADJUSTMENT: 'Admin adjustment',
};

export default async function ProfilePage({ params }: { params: { id: string } }) {
  const user = await prisma.user.findUnique({
    where: { id: params.id },
    include: {
      _count: { select: { submissions: true, verifications: true } },
      trustEvents: { orderBy: { createdAt: 'desc' }, take: 25 },
      submissions: { orderBy: { createdAt: 'desc' }, take: 10, include: { tags: { include: { tag: true } } } },
      verifications: {
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { submission: { select: { id: true, hackName: true, status: true } } },
      },
    },
  });

  if (!user) notFound();

  const tier = getTrustTier(user.trustScore);
  const approvedCount = user.submissions.filter((s) => s.status === 'APPROVED').length;
  const rejectedCount = user.submissions.filter((s) => s.status === 'REJECTED').length;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-5 mb-10">
        <Avatar src={user.image} name={user.name} size={72} />
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="font-display text-2xl font-bold">{user.name}</h1>
            {user.role === 'ADMINISTRATOR' && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-phosphor/10 text-phosphor border border-phosphor/30">Administrator</span>
            )}
            {user.role === 'VERIFIER' && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-status-verified-bg text-status-verified border border-status-verified/30">Verifier</span>
            )}
            {user.role === 'GUEST' && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-bg-elevated text-text-muted border border-border" title="Submit a hack to become a Contributor">Guest</span>
            )}
          </div>
          {user.bio && <p className="text-text-secondary text-sm mt-1">{user.bio}</p>}
          <p className="text-xs text-text-muted mt-1">
            Joined {format(new Date(user.createdAt), 'MMMM yyyy')} · {tier} tier
          </p>
        </div>
        <div className="text-right">
          <TrustBadge score={user.trustScore} showWeight />
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-10">
        {[
          { label: 'Submissions', value: user._count.submissions },
          { label: 'Approved', value: approvedCount },
          { label: 'Verifications', value: user._count.verifications },
          { label: 'Rejected', value: rejectedCount },
        ].map((stat) => (
          <div key={stat.label} className="p-4 rounded-lg border border-border bg-bg-surface text-center">
            <p className="font-display text-2xl font-bold text-phosphor font-numeric">{stat.value}</p>
            <p className="text-xs text-text-muted mt-1">{stat.label}</p>
          </div>
        ))}
      </div>

      <div className="grid lg:grid-cols-2 gap-8">
        {/* Submissions */}
        <div>
          <h2 className="font-display text-lg font-bold mb-4">Recent submissions</h2>
          <div className="space-y-2">
            {user.submissions.length === 0 && <p className="text-sm text-text-muted">No submissions yet.</p>}
            {user.submissions.map((s) => (
              <Link key={s.id} href={`/submissions/${s.id}`} className="flex items-center justify-between p-3 rounded-lg border border-border bg-bg-surface hover:border-phosphor/30 transition-colors">
                <div>
                  <p className="text-sm font-medium text-text-primary">{s.hackName} <span className="text-text-muted font-normal">v{s.version}</span></p>
                  <p className="text-xs text-text-muted">{formatDistanceToNow(new Date(s.createdAt), { addSuffix: true })}</p>
                </div>
                <StatusBadge status={s.status} size="sm" />
              </Link>
            ))}
          </div>
        </div>

        {/* Verifications */}
        <div>
          <h2 className="font-display text-lg font-bold mb-4">Recent verifications</h2>
          <div className="space-y-2">
            {user.verifications.length === 0 && <p className="text-sm text-text-muted">No verifications yet.</p>}
            {user.verifications.map((v) => (
              <Link key={v.id} href={`/submissions/${v.submission.id}`} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-bg-surface hover:border-phosphor/30 transition-colors">
                {v.matches ? <CheckCircle2 size={14} className="text-status-approved shrink-0" /> : <XCircle size={14} className="text-status-rejected shrink-0" />}
                <p className="text-sm text-text-primary flex-1 truncate">{v.submission.hackName}</p>
                <span className="text-xs text-text-muted">{formatDistanceToNow(new Date(v.createdAt), { addSuffix: true })}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Trust history */}
      <div className="mt-10">
        <h2 className="font-display text-lg font-bold mb-4">Trust history</h2>
        <div className="rounded-lg border border-border overflow-hidden">
          {user.trustEvents.length === 0 && (
            <p className="text-sm text-text-muted p-4">No trust events yet.</p>
          )}
          {user.trustEvents.map((event) => (
            <div key={event.id} className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle last:border-0">
              {event.delta >= 0 ? <TrendingUp size={14} className="text-status-approved shrink-0" /> : <TrendingDown size={14} className="text-status-rejected shrink-0" />}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-text-primary">{EVENT_LABELS[event.eventType] ?? event.eventType}</p>
                <p className="text-xs text-text-muted truncate">{event.reason}</p>
              </div>
              <span className={`font-numeric text-sm font-semibold ${event.delta >= 0 ? 'text-status-approved' : 'text-status-rejected'}`}>
                {event.delta > 0 ? '+' : ''}{event.delta}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
