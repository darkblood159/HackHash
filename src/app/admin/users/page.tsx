// src/app/admin/users/page.tsx
import React from 'react';
import { prisma } from '@/lib/prisma';
import { Avatar } from '@/components/ui/Avatar';
import { TrustBadge } from '@/components/ui/TrustBadge';
import { format } from 'date-fns';
import { UserActionMenu } from '@/components/UserActionMenu';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage() {
  // Comment counts are fetched separately, filtered to isDeleted: false, and
  // merged in by userId — rather than an unfiltered _count on the relation
  // (like submissions/verifications below still use). Those two can't
  // currently go stale since nothing removes a submission/verification row
  // outright, but comments can now be individually or mass-deleted, and the
  // "Delete all comments (N)" action in UserActionMenu needs N to actually
  // drop once that happens — an unfiltered count would keep showing the
  // original number forever, looking like the action silently did nothing.
  const [users, commentCounts] = await Promise.all([
    prisma.user.findMany({
      select: {
        id: true, name: true, email: true, image: true, role: true,
        trustScore: true, isBanned: true, createdAt: true,
        _count: { select: { submissions: true, verifications: true } },
      },
      orderBy: { trustScore: 'desc' },
      take: 50,
    }),
    prisma.comment.groupBy({
      by: ['userId'],
      where: { isDeleted: false },
      _count: { _all: true },
    }),
  ]);
  const commentCountByUser = new Map(commentCounts.map((c) => [c.userId, c._count._all]));

  return (
    <div>
      <p className="text-sm text-text-muted mb-6">{users.length} users, sorted by trust score</p>

      <div className="rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-bg-elevated text-text-muted text-xs uppercase tracking-wider">
            <tr>
              <th className="text-left px-4 py-3 font-medium rounded-tl-lg">User</th>
              <th className="text-left px-4 py-3 font-medium">Role</th>
              <th className="text-left px-4 py-3 font-medium">Trust</th>
              <th className="text-left px-4 py-3 font-medium hidden sm:table-cell">Submissions</th>
              <th className="text-left px-4 py-3 font-medium hidden md:table-cell">Joined</th>
              <th className="text-right px-4 py-3 font-medium rounded-tr-lg">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-border-subtle hover:bg-bg-elevated transition-colors">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Avatar src={u.image} name={u.name} size={28} />
                    <div>
                      <p className="text-text-primary font-medium">{u.name}</p>
                      {u.isBanned && <span className="text-[10px] text-status-rejected">Banned</span>}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-text-secondary">{u.role}</td>
                <td className="px-4 py-3"><TrustBadge score={u.trustScore} /></td>
                <td className="px-4 py-3 text-text-muted hidden sm:table-cell">{u._count.submissions}</td>
                <td className="px-4 py-3 text-text-muted hidden md:table-cell">{format(new Date(u.createdAt), 'MMM yyyy')}</td>
                <td className="px-4 py-3 text-right">
                  <UserActionMenu userId={u.id} currentRole={u.role} trustScore={u.trustScore} isBanned={u.isBanned} commentCount={commentCountByUser.get(u.id) ?? 0} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
