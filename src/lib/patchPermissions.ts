// src/lib/patchPermissions.ts
//
// Single source of truth for "who can upload, replace, or remove a
// submission's patch FILE" — used by both POST/DELETE
// /api/submissions/[id]/patch (the actual enforcement) and
// src/app/submissions/[id]/page.tsx (to decide what the UI even shows).
// Deliberately one function imported by both rather than the rule being
// written twice in two places that could quietly drift apart — the
// classic "client shows a button server would reject" bug this sidesteps
// by construction rather than by discipline.
//
// The rule, in plain terms (as asked for): while no patch file is
// attached yet, the existing owner-while-PENDING-or-admin rule from
// section 2as applies unchanged. Once one IS attached, only ADMINISTRATOR
// or VERIFIER can change, replace, or remove it — not even the original
// owner, regardless of submission status. Deliberately does NOT fold in
// the trust-score veteran bypass canCastManualVote (approval.ts) uses for
// manual verification — that's a different rule for a different action;
// this one was asked for as role-only ("admins or verifiers"), not
// role-or-high-trust.
//
// Scoped per SUBMISSION ROW, not per hack/family — a new version (a
// different Submission row, its own hackFamilyId grouping the same hack's
// versions together) starts with its own null patchUploadedAt and is
// completely unaffected by another version's lock. Nothing below needs to
// special-case this; it falls out of only ever looking at the one
// submission passed in.

export interface PatchPermissionInput {
  viewerId: string | null | undefined;
  viewerRole: string | null | undefined;
  submittedById: string;
  status: string;
  patchUploadedAt: Date | string | null;
}

export function canManagePatchFile({
  viewerId,
  viewerRole,
  submittedById,
  status,
  patchUploadedAt,
}: PatchPermissionInput): boolean {
  const isPrivileged = viewerRole === 'ADMINISTRATOR' || viewerRole === 'VERIFIER';
  if (isPrivileged) return true;
  if (patchUploadedAt) return false; // locked — a file already exists, non-privileged access ends here
  return !!viewerId && viewerId === submittedById && status === 'PENDING';
}
