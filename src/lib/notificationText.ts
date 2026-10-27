// src/lib/notificationText.ts
//
// What each notification SAYS, as pure functions (zero imports, so tests and
// the UI can load it without Prisma). The text is written once, at creation
// time, and stored on the row: a later rename of a hack must not rewrite the
// history of what the person was told.
//
// Two rules these builders follow on purpose:
//  1. NO admin-typed free text (rejection reasons, review notes, report
//     resolution notes) is ever copied into a notification. Admins write those
//     with a particular audience in mind and some of it is internal; each
//     notification instead links to the page where that person can already see
//     whatever is visible to them. Copying notes in is a one-line change per
//     builder if the owner decides they should be included.
//  2. Nothing is promised that might not be true ("see the reason below"),
//     because a rejection can legitimately have no reason attached.

export const NOTIFICATION_TYPES = [
  'SUBMISSION_APPROVED',
  'SUBMISSION_REJECTED',
  'SUBMISSION_DISPUTED',
  'BATCH_WITHDRAWN',
  'CHANGE_REQUEST_APPROVED',
  'CHANGE_REQUEST_REJECTED',
  'ISSUE_RESOLVED',
  'ISSUE_DISMISSED',
  'COMMENT_ON_SUBMISSION',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Fired on `window` after notifications are marked read, so the navbar bell re-counts at once. */
export const NOTIFICATIONS_CHANGED_EVENT = 'notifications:changed';

export interface NotificationContent {
  type: NotificationType;
  title: string;
  body: string | null;
  href: string;
  /** Present when the notification is about one submission (used to skip duplicates). */
  submissionId: string | null;
}

/** Longest hack/person name quoted inside a title; longer ones are cut with an ellipsis. */
export const NAME_MAX = 80;

function clip(name: string | null | undefined, fallback: string): string {
  const cleaned = (name ?? '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return fallback;
  return cleaned.length > NAME_MAX ? cleaned.slice(0, NAME_MAX - 1).trimEnd() + '…' : cleaned;
}

const q = (s: string) => `“${s}”`;
const subHref = (id: string) => `/submissions/${encodeURIComponent(id)}`;

export function submissionApproved(sub: { id: string; hackName: string }): NotificationContent {
  return {
    type: 'SUBMISSION_APPROVED',
    title: `${q(clip(sub.hackName, 'Your submission'))} was approved`,
    body: 'It is now in the database.',
    href: subHref(sub.id),
    submissionId: sub.id,
  };
}

export function submissionRejected(sub: { id: string; hackName: string }): NotificationContent {
  return {
    type: 'SUBMISSION_REJECTED',
    title: `${q(clip(sub.hackName, 'Your submission'))} was rejected`,
    body: 'Open it to see the details.',
    href: subHref(sub.id),
    submissionId: sub.id,
  };
}

export function submissionDisputed(sub: { id: string; hackName: string }): NotificationContent {
  return {
    type: 'SUBMISSION_DISPUTED',
    title: `${q(clip(sub.hackName, 'Your submission'))} was marked disputed`,
    body: 'Its verification result is being questioned. Check the votes and comments.',
    href: subHref(sub.id),
    submissionId: sub.id,
  };
}

export function batchWithdrawn(count: number, userId: string): NotificationContent {
  return {
    type: 'BATCH_WITHDRAWN',
    title: `${count} of your bulk-submitted ${count === 1 ? 'entry was' : 'entries were'} withdrawn`,
    body: 'An admin withdrew a bulk submission batch that included them.',
    href: `/profile/${encodeURIComponent(userId)}`,
    submissionId: null,
  };
}

export function changeRequestDecided(
  approved: boolean,
  sub: { id: string; hackName: string },
): NotificationContent {
  return {
    type: approved ? 'CHANGE_REQUEST_APPROVED' : 'CHANGE_REQUEST_REJECTED',
    title: approved
      ? `Your change to ${q(clip(sub.hackName, 'a submission'))} was approved`
      : `Your change to ${q(clip(sub.hackName, 'a submission'))} was not accepted`,
    body: approved ? 'The edit has been applied.' : 'Open the submission to see any review note.',
    href: subHref(sub.id),
    submissionId: sub.id,
  };
}

export function issueClosed(
  resolved: boolean,
  sub: { id: string; hackName: string },
): NotificationContent {
  return {
    type: resolved ? 'ISSUE_RESOLVED' : 'ISSUE_DISMISSED',
    title: resolved
      ? `Your report on ${q(clip(sub.hackName, 'an entry'))} was resolved`
      : `Your report on ${q(clip(sub.hackName, 'an entry'))} was reviewed`,
    body: resolved ? 'Thanks for flagging it.' : 'It was closed without changes.',
    href: subHref(sub.id),
    submissionId: sub.id,
  };
}

export function commentOnSubmission(
  sub: { id: string; hackName: string },
  commenterName: string | null | undefined,
): NotificationContent {
  return {
    type: 'COMMENT_ON_SUBMISSION',
    title: `${clip(commenterName, 'Someone')} commented on ${q(clip(sub.hackName, 'your submission'))}`,
    body: null,
    href: `${subHref(sub.id)}#comments`,
    submissionId: sub.id,
  };
}
