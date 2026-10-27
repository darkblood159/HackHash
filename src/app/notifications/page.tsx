// src/app/notifications/page.tsx
//
// The signed-in user's own notifications (latest 50). Signed-out visitors are
// sent to sign in and brought back here. Never shows anyone else's rows: the
// query is scoped to the session user, same as the API routes.
import React from 'react';
import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { NotificationList, type NotificationItem } from '@/components/NotificationList';

export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    redirect('/auth/signin?callbackUrl=/notifications');
  }

  let items: NotificationItem[] = [];
  let loadFailed = false;
  try {
    const rows = await prisma.notification.findMany({
      where: { userId: session.user.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 50,
      select: { id: true, type: true, title: true, body: true, href: true, readAt: true, createdAt: true },
    });
    items = rows.map((r) => ({
      ...r,
      readAt: r.readAt ? r.readAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    }));
  } catch (err) {
    // e.g. the migration has not been applied yet: say so plainly instead of a 500 page.
    console.error('Notifications page: load failed:', err);
    loadFailed = true;
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-12">
      <h1 className="font-display text-2xl font-bold mb-1">Notifications</h1>
      <p className="text-text-secondary text-sm mb-6">
        Updates on your submissions, change requests and reports.
      </p>

      {loadFailed ? (
        <p role="alert" className="text-sm text-text-muted">Notifications could not be loaded right now. Please try again later.</p>
      ) : (
        <NotificationList initial={items} />
      )}
    </div>
  );
}
