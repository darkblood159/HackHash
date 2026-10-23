// src/lib/issueReports.ts
//
// The "Report issue" feature's single source of truth: which kinds of problem a
// person can pick, how they're worded, and the validation both the form and the
// API apply. ZERO imports on purpose — the client form, the admin queue and the
// API route all use it, and it can be unit-tested without Prisma/Next.

export type IssueTypeValue =
  | 'BROKEN_LINK'
  | 'PATCH_MISSING'
  | 'PATCH_WONT_APPLY'
  | 'GAME_BROKEN'
  | 'WRONG_INFO'
  | 'HASH_MISMATCH'
  | 'DUPLICATE'
  | 'INAPPROPRIATE'
  | 'OTHER';

export interface IssueTypeInfo {
  value: IssueTypeValue;
  /** Short label (radio list, admin chips). */
  label: string;
  /** One line under the label in the form. */
  hint: string;
  /** A comment is mandatory (only "Other": a bare "Other" tells an admin nothing). */
  commentRequired?: boolean;
}

// Order = order shown in the form: the likeliest problems first.
export const ISSUE_TYPES: readonly IssueTypeInfo[] = [
  { value: 'BROKEN_LINK', label: 'Broken link', hint: 'A link is dead or goes to the wrong place' },
  { value: 'PATCH_MISSING', label: 'Patch missing or won’t download', hint: 'No patch file, or the download fails' },
  { value: 'PATCH_WONT_APPLY', label: 'Patch won’t apply', hint: 'Errors when patching, or the wrong base ROM is listed' },
  { value: 'GAME_BROKEN', label: 'Game is broken', hint: 'Crashes, freezes, or won’t start after patching' },
  { value: 'WRONG_INFO', label: 'Wrong or missing info', hint: 'Name, author, version, tags, links or matches look wrong' },
  { value: 'HASH_MISMATCH', label: 'Checksums don’t match', hint: 'CRC32 / MD5 / SHA-1 differ from the real file' },
  { value: 'DUPLICATE', label: 'Duplicate entry', hint: 'The same hack is already listed elsewhere' },
  { value: 'INAPPROPRIATE', label: 'Spam, malware or inappropriate', hint: 'Content that shouldn’t be here' },
  { value: 'OTHER', label: 'Something else', hint: 'Anything not listed above', commentRequired: true },
] as const;

const BY_VALUE = new Map<string, IssueTypeInfo>(ISSUE_TYPES.map((t) => [t.value, t]));

export function issueTypeLabel(value: string): string {
  return BY_VALUE.get(value)?.label ?? value;
}

export function isIssueType(v: unknown): v is IssueTypeValue {
  return typeof v === 'string' && BY_VALUE.has(v);
}

export const ISSUE_COMMENT_MAX = 1000;
export const ISSUE_NOTE_MAX = 500;

/**
 * People will paste a whole entry URL (…/submissions/<id>) far more readily
 * than a bare cuid, so accept either. Returns null for blank input; anything
 * else is handed back as the best guess at an id (the route checks it exists).
 */
export function extractSubmissionId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const t = input.trim();
  if (!t) return null;
  const m = t.match(/\/submissions\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : t;
}

export interface IssueInput {
  type: IssueTypeValue;
  comment: string | null;
  duplicateOfId: string | null;
}

export type IssueValidation = { ok: true; data: IssueInput } | { ok: false; error: string };

/** Pure validation of a POST body. Never throws. */
export function validateIssueInput(body: unknown): IssueValidation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Invalid request' };
  const b = body as Record<string, unknown>;
  if (!isIssueType(b.type)) return { ok: false, error: 'Pick what kind of issue this is' };

  let comment: string | null = null;
  if (b.comment !== undefined && b.comment !== null) {
    if (typeof b.comment !== 'string') return { ok: false, error: 'Invalid comment' };
    const c = b.comment.trim();
    if (c.length > ISSUE_COMMENT_MAX) return { ok: false, error: `Comment is too long (max ${ISSUE_COMMENT_MAX} characters)` };
    comment = c || null;
  }
  if (BY_VALUE.get(b.type)!.commentRequired && !comment) {
    return { ok: false, error: 'Please leave a short comment so we know what’s wrong' };
  }

  // Only a duplicate report can name an original; ignored for every other type.
  const duplicateOfId = b.type === 'DUPLICATE' ? extractSubmissionId(b.duplicateOfId) : null;
  return { ok: true, data: { type: b.type, comment, duplicateOfId } };
}
