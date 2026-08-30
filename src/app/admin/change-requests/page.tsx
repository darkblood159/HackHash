// src/app/admin/change-requests/page.tsx
import React from 'react';
import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { Avatar } from '@/components/ui/Avatar';
import { formatDistanceToNow } from 'date-fns';
import { FIELD_LABELS } from '@/lib/fieldLabels';

export const dynamic = 'force-dynamic';

export default async function AdminChangeRequestsPage() {
  const requests = await prisma.changeRequest.findMany({
    where: { status: 'PENDING' },
    include: {
      requestedBy: { select: { id: true, name: true, image: true } },
      submission: { select: { id: true, hackName: true, version: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });

  return (
    <div>
      <p className="text-sm text-text-muted mb-6">{requests.length} pending change request(s)</p>

      {requests.length === 0 && (
        <div className="text-center py-20 border border-dashed border-border rounded-xl text-text-muted">
          No pending change requests.
        </div>
      )}

      <div className="space-y-2">
        {requests.map((r) => (
          <Link
            key={r.id}
            href={`/submissions/${r.submission.id}`}
            className="flex items-start gap-3 p-4 rounded-lg border border-border bg-bg-surface hover:border-phosphor/30 transition-colors"
          >
            <Avatar src={r.requestedBy.image} name={r.requestedBy.name} size={32} />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-text-primary">
                <span className="font-medium">{r.requestedBy.name}</span> wants to change{' '}
                <span className="text-phosphor">{r.submission.hackName} v{r.submission.version}</span>
              </p>
              <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-text-muted">
                {Object.keys(r.changes as Record<string, unknown>).map((field) => (
                  <span key={field}>{FIELD_LABELS[field] ?? field}</span>
                ))}
              </div>
              <p className="text-xs text-text-muted mt-1">{formatDistanceToNow(new Date(r.createdAt), { addSuffix: true })}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
