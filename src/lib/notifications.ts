// src/lib/notifications.ts
//
// Creating, counting and reading in-app notifications. The text of each kind
// lives in notificationText.ts; this file is the part that talks to the DB.
//
// THE ONE RULE: nothing in here may ever throw into the caller. Notifications
// are created AFTER the action they describe has committed (an approval, a
// rejection, a comment ...), so a failure here - the table missing because a
// migration has not run yet, a transient connection error - must cost one
// notification, never the action itself. Every exported writer catches and
// logs. (Readers used by the navbar badge catch too: "a badge must never
// throw", same convention as /api/admin/reports/count.)
import { prisma } from '@/lib/prisma';
import type { NotificationContent } from '@/lib/notificationText';

/** A person who is the one performing the action is never told about it. */
function isSelf(userId: string, actorId: string | null | undefined): boolean {
  return !!actorId && userId === actorId;
}

/** Read notifications older than this are deleted whenever that user receives a new one. */
export const READ_RETENTION_DAYS = 60;
/** Unread ones are kept longer, but not forever. */
export const UNREAD_RETENTION_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Create one notification for `userId`. Best-effort: returns true if a row was
 * written, false if it was skipped (self-notification, duplicate) or failed.
 *
 * Skips when the same person already has an UNREAD notification of the same
 * type about the same submission. That one rule keeps a busy comment thread,
 * or a score that flips between Pending and Disputed, from burying someone
 * under identical items; once they read it, the next event notifies again.
 */
export async function notify(
  userId: string,
  content: NotificationContent,
  opts: { actorId?: string | null } = {},
): Promise<boolean> {
  try {
    if (!userId || isSelf(userId, opts.actorId)) return false;

    if (content.submissionId) {
      const existing = await prisma.notification.findFirst({
        where: { userId, type: content.type, submissionId: content.submissionId, readAt: null },
        select: { id: true },
      });
      if (existing) return false;
    }

    await prisma.notification.create({
      data: {
        userId,
        type: content.type,
        title: content.title,
        body: content.body,
        href: content.href,
        submissionId: content.submissionId,
      },
    });

    // Housekeeping rides along with creation so there is no scheduled job to run.
    const now = Date.now();
    await prisma.notification.deleteMany({
      where: {
        userId,
        OR: [
          { readAt: { not: null }, createdAt: { lt: new Date(now - READ_RETENTION_DAYS * DAY_MS) } },
          { createdAt: { lt: new Date(now - UNREAD_RETENTION_DAYS * DAY_MS) } },
        ],
      },
    });
    return true;
  } catch (err) {
    console.error('notify failed (ignored):', err);
    return false;
  }
}

/** Notify several people about the same thing (each is deduped and self-checked on its own). */
export async function notifyMany(
  userIds: string[],
  content: NotificationContent,
  opts: { actorId?: string | null } = {},
): Promise<number> {
  let written = 0;
  for (const id of Array.from(new Set(userIds))) {
    if (await notify(id, content, opts)) written++;
  }
  return written;
}

/** Unread count for the navbar badge. Never throws; 0 on any failure. */
export async function unreadCount(userId: string): Promise<number> {
  try {
    return await prisma.notification.count({ where: { userId, readAt: null } });
  } catch {
    return 0;
  }
}
