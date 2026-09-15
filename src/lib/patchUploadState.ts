// src/lib/patchUploadState.ts
//
// Just the constant name + message for the patch-upload kill switch,
// deliberately split out from src/lib/siteSettings.ts (which reads/writes
// the actual SiteSetting row and therefore imports the Prisma client).
// PatchFileUpload.tsx is a 'use client' component — importing
// siteSettings.ts's arePatchUploadsDisabled()/setPatchUploadsDisabled()
// directly from there would pull a server-only Prisma import into the
// browser bundle just to read one string. This tiny file has no imports of
// its own, so it's safe on either side; siteSettings.ts re-exports these
// same two values rather than redeclaring them, so the key and the
// user-facing message can't drift between the two files.
export const PATCH_UPLOADS_DISABLED_KEY = 'patch_uploads_disabled';
export const PATCH_UPLOADS_DISABLED_MESSAGE = 'Uploads are temporarily disabled.';
