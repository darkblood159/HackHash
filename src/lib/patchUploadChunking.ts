// src/lib/patchUploadChunking.ts
//
// Constants shared by the chunked patch upload's client (chunkedUpload.ts,
// PatchFileUpload.tsx) and server (patchUploadSession.ts, the routes under
// /api/submissions/[id]/patch/uploads). Deliberately its own tiny file with
// NO imports — same reason patchUploadState.ts is split out from
// siteSettings.ts: PatchFileUpload.tsx is a 'use client' component, and
// pulling a server-only module (fs, Prisma) into the browser bundle just to
// read one number would break the build.
//
// WHY UPLOADS ARE CHUNKED AT ALL: Cloudflare caps a single proxied request
// body (100MB on Free/Pro, 200MB Business, 500MB Enterprise by default) and
// this app sits behind it. The cap is per REQUEST, so a file of any size gets
// through as a series of requests that each stay under it.

/**
 * Files larger than this go through the chunked path; files at or below it
 * keep using the original single multipart POST (which buffers the whole file
 * in server memory — fine at this size, and it keeps the long-proven path in
 * use for the overwhelmingly common small-patch case). Comfortably below
 * Cloudflare's 100MB Free/Pro cap even with multipart overhead.
 */
export const CHUNKED_UPLOAD_THRESHOLD_BYTES = 32 * 1024 * 1024;

/**
 * Smallest chunk the client will shrink to when retrying on a flaky
 * connection (it halves the chunk size after repeated failures). The
 * server-chosen chunk size is the ceiling; see PATCH_UPLOAD_CHUNK_BYTES in
 * patchUploadSession.ts.
 */
export const MIN_CHUNK_BYTES = 4 * 1024 * 1024;

/** Header carrying the byte offset a chunk starts at (tus-style, without the tus protocol). */
export const UPLOAD_OFFSET_HEADER = 'X-Upload-Offset';
