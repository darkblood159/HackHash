// src/lib/patchApplyProtocol.ts
//
// The messages between the page and the patch-apply Web Worker
// (src/workers/patchApply.worker.ts), plus the one error that is not a patch
// problem. Zero imports so the worker, the client and the tests share it.
//
// Only an error MESSAGE crosses the boundary (never an Error object, whose
// class would not survive structured cloning): the page turns it back into a
// PatchApplyError, which is what every caller already catches.

export interface ApplyRequest {
  /** Matches a reply to the request that caused it. */
  id: number;
  patchType: string;
  patch: Uint8Array;
  rom: Uint8Array;
}

export type ApplyResponse =
  | { id: number; ok: true; output: Uint8Array }
  | { id: number; ok: false; message: string };

/** Thrown (as a rejection) when the person cancels a patch in progress. Not a failure. */
export class PatchApplyCancelled extends Error {
  constructor() {
    super('Patching was cancelled.');
    this.name = 'PatchApplyCancelled';
  }
}

/** Shown when the worker itself dies (out of memory, script failed to load) rather than reporting a patch error. */
export const WORKER_FAILED_MESSAGE =
  "Couldn't apply the patch: the background task stopped unexpectedly. The ROM or patch may be too large for this device's memory — try again, or use a desktop browser.";
