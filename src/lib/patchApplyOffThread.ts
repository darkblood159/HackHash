// src/lib/patchApplyOffThread.ts
//
// What the app calls to apply a patch without freezing the page. It binds
// patchApplyClient.ts to the real Web Worker. Kept separate because the worker
// URL (`new URL(..., import.meta.url)`) is bundler syntax: the client file stays
// free of it so it can be tested directly.
//
// The `new Worker(new URL(...))` expression has to appear in exactly this form
// for webpack to see it and emit the worker as its own chunk.
import { startPatchApplyWith, type PatchApplyJob, type StartOptions, type WorkerLike } from './patchApplyClient';
import type { PatchTypeValue } from './patchTypes';

function createPatchWorker(): WorkerLike | null {
  if (typeof Worker === 'undefined') return null; // no Worker support: caller falls back to the main thread
  return new Worker(new URL('../workers/patchApply.worker.ts', import.meta.url)) as unknown as WorkerLike;
}

/** Start applying; returns a job that can be awaited or cancelled. */
export function startPatchApply(
  patchType: PatchTypeValue,
  patchBytes: Uint8Array,
  romBytes: Uint8Array,
  opts?: StartOptions,
): PatchApplyJob {
  return startPatchApplyWith(createPatchWorker, patchType, patchBytes, romBytes, opts);
}

/** Apply and wait for the result (no cancel handle). */
export function applyPatchOffThread(
  patchType: PatchTypeValue,
  patchBytes: Uint8Array,
  romBytes: Uint8Array,
  opts?: StartOptions,
): Promise<Uint8Array> {
  return startPatchApply(patchType, patchBytes, romBytes, opts).promise;
}

export { PatchApplyCancelled } from './patchApplyProtocol';
