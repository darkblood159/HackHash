// src/lib/siteSettings.ts
//
// Thin helpers around the existing SiteSetting key-value table
// (prisma/schema.prisma) for simple admin-toggleable switches that need to
// be read from more than one place — an API route AND the page/component
// that renders around it — without those call sites drifting on what
// "on"/"off" actually looks like as a stored string. Same underlying table
// src/lib/trust.ts and src/lib/dat-generator.ts already read from for trust
// deltas / status thresholds / DAT metadata; this just gives the one new
// key its own small, named, reusable surface instead of every caller
// re-writing its own findUnique + string comparison.
//
// SCOPE, DELIBERATE: this only gates the actual PATCH FILE UPLOAD endpoint
// (POST /api/submissions/[id]/patch) — attaching or replacing the bytes of
// a patch on a submission. It does NOT touch:
//   - GET /api/submissions/[id]/patch (downloading an already-stored patch)
//   - the in-browser "patch your ROM" apply flow (PatchApplyButton.tsx /
//     src/lib/patchApply.ts), which only ever downloads a patch + hashes
//     the visitor's own ROM locally — it never uploads anything itself
//   - PatchDropzone.tsx (SubmitForm/ChangeRequestSection), which only
//     computes a hash client-side to fill in form fields and never calls
//     this endpoint at all (its own UI copy already promises "the file
//     itself is never uploaded")
//   - removing an already-attached patch file (DELETE), since clearing a
//     file isn't "uploading" one
// This is intentional: the ask was a way to pause new/replacement patch
// uploads without taking down the separately-built, already-independent
// download/apply-in-browser feature ("the patching").
import { prisma } from './prisma';
// Re-exported (not redeclared) from a small, import-free file so a client
// component (PatchFileUpload.tsx) can show the exact same key/message this
// file enforces without pulling this file's own Prisma import into the
// browser bundle — see patchUploadState.ts's own header comment.
export { PATCH_UPLOADS_DISABLED_KEY, PATCH_UPLOADS_DISABLED_MESSAGE } from './patchUploadState';
import { PATCH_UPLOADS_DISABLED_KEY } from './patchUploadState';

export async function arePatchUploadsDisabled(): Promise<boolean> {
  try {
    const setting = await prisma.siteSetting.findUnique({ where: { key: PATCH_UPLOADS_DISABLED_KEY } });
    return setting?.value === 'true';
  } catch {
    // Fail OPEN (uploads stay enabled) on a settings-table hiccup — same
    // reasoning as getTrustDelta()'s identical try/catch in trust.ts: a
    // read failure here shouldn't be what takes the upload endpoint down.
    return false;
  }
}

export async function setPatchUploadsDisabled(disabled: boolean, updatedBy?: string): Promise<void> {
  await prisma.siteSetting.upsert({
    where: { key: PATCH_UPLOADS_DISABLED_KEY },
    update: { value: String(disabled), updatedBy },
    create: { key: PATCH_UPLOADS_DISABLED_KEY, value: String(disabled), updatedBy },
  });
}
