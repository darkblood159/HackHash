'use client';

// src/components/NotificationList.tsx
//
// The list on /notifications. Clicking an item marks it read and follows its
// link; "Mark all as read" clears the lot. Reads are tried best-effort: if the
// request fails the item just stays unread locally too (nothing is lost, the
// person can try again).
//
// After any change it fires a `notifications:changed` window event so the
// navbar bell re-counts straight away instead of waiting for the next
// navigation.
import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import { Bell, CheckCheck } from 'lucide-react';
import { clsx } from 'clsx';
import { NOTIFICATIONS_CHANGED_EVENT } from '@/lib/notificationText';

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  href: string;
  readAt: string | null;
  createdAt: string;
}

function announceChange() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
}

export function NotificationList({ initial }: { initial: NotificationItem[] }) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unread = items.filter((n) => !n.readAt).length;

  // keepalive lets the request finish even though the click is also navigating away.
  function markOneRead(id: string) {
    setItems((prev) => prev.map((n) => (n.id === id && !n.readAt ? { ...n, readAt: new Date().toISOString() } : n)));
    fetch('/api/notifications/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
      keepalive: true,
    })
      .then(announceChange)
      .catch(() => {});
  }

  async function markAllRead() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      if (!res.ok) throw new Error('failed');
      const now = new Date().toISOString();
      setItems((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt: now })));
      announceChange();
      router.refresh();
    } catch {
      setError('Could not mark them as read. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-16 text-text-muted">
        <Bell size={28} className="mx-auto mb-3 opacity-50" aria-hidden="true" />
        <p className="text-sm">Nothing yet. You will see approvals, rejections, comments and report outcomes here.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4 min-h-8">
        <p className="text-xs text-text-muted" aria-live="polite">
          {unread > 0 ? `${unread} unread` : 'All caught up'}
        </p>
        {unread > 0 && (
          <button
            type="button"
            onClick={markAllRead}
            disabled={busy}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-text-secondary hover:text-phosphor hover:bg-phosphor/10 transition-colors disabled:opacity-50"
          >
            <CheckCheck size={14} aria-hidden="true" />
            Mark all as read
          </button>
        )}
      </div>

      {error && <p role="alert" className="text-xs text-status-rejected mb-3">{error}</p>}

      <ul className="space-y-2">
        {items.map((n) => (
          <li key={n.id}>
            <Link
              href={n.href}
              onClick={() => { if (!n.readAt) markOneRead(n.id); }}
              className={clsx(
                'block px-4 py-3 rounded-lg border transition-colors',
                n.readAt
                  ? 'bg-bg-surface border-border hover:border-phosphor/30'
                  : 'bg-phosphor/5 border-phosphor/30 hover:border-phosphor/50',
              )}
            >
              <div className="flex items-start gap-2">
                {!n.readAt && (
                  <span aria-label="Unread" className="mt-1.5 w-2 h-2 rounded-full bg-phosphor shrink-0" />
                )}
                <div className="min-w-0">
                  <p className={clsx('text-sm break-words', n.readAt ? 'text-text-secondary' : 'text-text-primary font-medium')}>
                    {n.title}
                  </p>
                  {n.body && <p className="text-xs text-text-muted mt-0.5 break-words">{n.body}</p>}
                  <p className="text-[11px] text-text-muted mt-1" title={new Date(n.createdAt).toLocaleString()}>
                    {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
                  </p>
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
