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
// isPrivilegedPatchRole below also backs a SECOND, related but distinct
// rule: only a privileged uploader can use the 'OTHER' patch-type escape
// hatch in validatePatchUpload (patchValidation.ts) — see that file and
// POST /api/submissions/[id]/patch for why. That rule reuses this exact
// function rather than re-deriving "is this role privileged" separately,
// for the same reason canManagePatchFile itself exists as one function.
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

// Exported on its own (not just inlined inside canManagePatchFile below)
// specifically so POST /api/submissions/[id]/patch can reuse the exact
// same definition of "privileged" for a second, unrelated decision — only
// letting a privileged uploader actually use the 'OTHER' patch-type
// escape hatch (validatePatchUpload, patchValidation.ts) that bypasses
// byte-signature detection. Two different rules sharing one role check by
// construction, not by remembering to keep two inline checks in sync.
export function isPrivilegedPatchRole(role: string | null | undefined): boolean {
  return role === 'ADMINISTRATOR' || role === 'VERIFIER';
}

export function canManagePatchFile({
  viewerId,
  viewerRole,
  submittedById,
  status,
  patchUploadedAt,
}: PatchPermissionInput): boolean {
  if (isPrivilegedPatchRole(viewerRole)) return true;
  if (patchUploadedAt) return false; // locked — a file already exists, non-privileged access ends here
  return !!viewerId && viewerId === submittedById && status === 'PENDING';
}
