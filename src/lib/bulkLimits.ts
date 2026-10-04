// src/lib/bulkLimits.ts
//
// Every number and string the bulk-submit feature (submit several versions of
// a hack — and their patches — in one sitting) is tuned by, in ONE place. All
// of these are starting points chosen when the feature was designed, not
// researched figures: change them here and nowhere else. Deliberately
// import-free (same idea as patchUploadState.ts), so the browser bundle can
// show the exact same key/message/limits the server enforces without pulling
// a Prisma import along with it. The server derives the tier before calling
// bulkLimitsFor(); the client never computes limits itself — it reads them
// from GET /api/submissions/batches.

/** SiteSetting key for the admin kill switch (src/lib/siteSettings.ts). */
export const BULK_SUBMIT_DISABLED_KEY = 'bulk_submit_disabled';
export const BULK_SUBMIT_DISABLED_MESSAGE =
  'Bulk submitting is temporarily disabled — you can still submit versions one at a time.';

/**
 * How long after creation a batch will still accept new submissions or
 * patch uploads. A batch is one sitting, not a standing permission — this
 * stops an old batch id becoming a long-lived way around the ordinary
 * (stricter) single-submission rate limit.
 */
export const BULK_BATCH_OPEN_HOURS = 24;

/** Most rows a single precheck request will look at. */
export const BULK_PRECHECK_MAX_ROWS = 50;

export interface BulkLimits {
  /** Most submissions one batch may contain. Counted from the DATABASE, not the rate limiter (which is a no-op when Upstash isn't configured). */
  maxRows: number;
  /** Most batches one account may start in any rolling 24 hours. */
  maxBatchesPerDay: number;
}

const NEW_ACCOUNT_LIMITS: BulkLimits = { maxRows: 10, maxBatchesPerDay: 2 };
const TRUSTED_LIMITS: BulkLimits = { maxRows: 25, maxBatchesPerDay: 10 };

/**
 * A brand-new account gets the smaller allowance; anyone past the 'new'
 * trust tier (see getTrustTier in trust.ts), and verifiers/admins
 * regardless of score, get the larger one. `tier` is passed in rather than
 * computed here so this file stays import-free.
 */
export function bulkLimitsFor(tier: 'new' | 'trusted' | 'veteran', role: string): BulkLimits {
  const privileged = role === 'ADMINISTRATOR' || role === 'VERIFIER';
  return privileged || tier !== 'new' ? TRUSTED_LIMITS : NEW_ACCOUNT_LIMITS;
}
