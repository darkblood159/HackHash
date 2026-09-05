// src/lib/fieldLimits.ts
//
// Per-field length/format limits for the Submission columns that are
// nullable at the Prisma level (prisma/schema.prisma) and editable after
// creation — single source of truth for the two places that validate an
// edit to an EXISTING submission: PATCH /api/submissions/[id] (immediate
// admin/owner edit) and POST /api/submissions/[id]/change-request (a
// proposed edit, applied later on approval). Before this, PATCH kept its
// own inline copy of these limits and the change-request route's `changes`
// bag had no per-field validation at all (a real, previously-flagged gap —
// see CLAUDE_HANDOFF.txt section 2w) — same "two hand-maintained copies
// that could drift" shape this project already consolidated once for
// FIELD_LABELS (src/lib/fieldLabels.ts) and tag/mapping-field handling.
// Written here once so both callers stay in sync going forward.
//
// Values mirror what POST /api/submissions (create) already enforces at
// creation time (src/app/api/submissions/route.ts) — kept as a
// hand-matched parallel copy rather than importing directly from create's
// own schema, since create's fields are .optional() (simply absent if not
// supplied) while an EDIT's fields are .nullable() (present-with-null
// explicitly clears an existing value) — different enough optionality
// shapes that literally sharing one z.object() across all three would need
// per-field unwrapping anyway. If a create-time limit ever changes, update
// the matching entry here too.
//
// Deliberately excludes hackName/version/platform: those three Submission
// columns are NOT nullable at the Prisma level, so "clear to null" never
// applies to them — each caller keeps its own small non-nullable check for
// those three instead (see patchFieldLimits in the PATCH route, and
// REQUIRED_STRING_LIMITS in the change-request route).
import { z } from 'zod';

export const NULLABLE_FIELD_LIMITS = {
  description: z.string().max(5000).nullable(),
  versionChangelog: z.string().max(3000).nullable(),
  author: z.string().max(200).nullable(),
  sourceUrl: z.string().url().nullable(),
  notes: z.string().max(5000).nullable(),
  releasePageUrl: z.string().url().or(z.literal('')).nullable(),
  githubUrl: z.string().url().or(z.literal('')).nullable(),
  patchType: z.enum(['IPS', 'BPS', 'UPS', 'XDELTA', 'PPF', 'APS']).nullable(),
  patchFilename: z.string().max(500).nullable(),
  patchSha1: z.string().regex(/^[0-9a-f]{40}$/i).nullable(),
} as const;

export type NullableLimitField = keyof typeof NULLABLE_FIELD_LIMITS;

export function isNullableLimitField(key: string): key is NullableLimitField {
  return Object.prototype.hasOwnProperty.call(NULLABLE_FIELD_LIMITS, key);
}
