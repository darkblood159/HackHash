// src/lib/patchApplyClient.ts
//
// The page-side half of off-thread patching: sends one apply request to a
// worker, resolves with the patched bytes, and can be cancelled. The way a
// worker is CREATED is passed in (see patchApplyOffThread.ts for the real one),
// so this file has no browser-only syntax and every branch can be tested with a
// fake worker.
//
// Guarantees:
//  - Exactly one worker per call, always terminated when the call ends in ANY
//    way (success, error, cancel): that is what frees a large buffer, and why a
//    cancelled job really stops.
//  - If no worker can be CREATED (no Worker support, the constructor throws) or
//    the request cannot be handed to it (posting fails), the SAME applyPatch
//    runs on the main thread, as before, after a tick so the "Applying..." text
//    can paint first.
//  - A worker that WAS created but then dies or errors out (its script failed
//    to load, out of memory, ...) becomes a readable PatchApplyError, not a
//    spinner that never ends. It deliberately does NOT retry on the main
//    thread: the likeliest cause is the job being too big for this device, and
//    redoing it on the page's own thread is exactly the freeze this file exists
//    to avoid. The person can cancel or try again.
//  - Settles exactly once; late messages from a cancelled/finished job are ignored.
import { applyPatch, PatchApplyError } from './patchApply';
import type { PatchTypeValue } from './patchTypes';
import { PatchApplyCancelled, WORKER_FAILED_MESSAGE, type ApplyRequest, type ApplyResponse } from './patchApplyProtocol';

/** The few Worker members used here (so a test can supply a fake). */
export interface WorkerLike {
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessageerror: ((ev: unknown) => void) | null;
  postMessage(message: ApplyRequest, transfer?: ArrayBuffer[]): void;
  terminate(): void;
}

export interface PatchApplyJob {
  /** Resolves with the patched bytes; rejects PatchApplyError (a problem) or PatchApplyCancelled (cancel()). */
  promise: Promise<Uint8Array>;
  /** Stops the job; its promise rejects with PatchApplyCancelled. Safe to call any number of times, before or after it settles. */
  cancel(): void;
}

export interface StartOptions {
  /**
   * The patch buffer is handed to the worker without copying (it becomes
   * unusable here). Only set this when the caller does not use the patch bytes
   * afterwards. The ROM is always COPIED, never transferred: callers keep using
   * it (the ROM cache, the next patch in a bulk run).
   */
  transferPatch?: boolean;
}

let nextId = 1;

export function startPatchApplyWith(
  createWorker: (() => WorkerLike | null) | null,
  patchType: PatchTypeValue,
  patchBytes: Uint8Array,
  romBytes: Uint8Array,
  opts: StartOptions = {},
): PatchApplyJob {
  let settled = false;
  let worker: WorkerLike | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rejectOuter: ((e: unknown) => void) | null = null;

  function teardown() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (worker) {
      const w = worker;
      worker = null;
      w.onmessage = null;
      w.onerror = null;
      w.onmessageerror = null;
      try {
        w.terminate();
      } catch {
        /* already gone */
      }
    }
  }

  const promise = new Promise<Uint8Array>((resolve, reject) => {
    rejectOuter = reject;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      teardown();
      settle();
    };

    const runOnMainThread = () => {
      // A tick first so React can paint "Applying..." before the (possibly long) synchronous work.
      timer = setTimeout(() => {
        timer = null;
        if (settled) return;
        try {
          const out = applyPatch(patchType, patchBytes, romBytes);
          finish(() => resolve(out));
        } catch (err) {
          finish(() => reject(err));
        }
      }, 0);
    };

    let w: WorkerLike | null = null;
    try {
      w = createWorker ? createWorker() : null;
    } catch {
      w = null;
    }
    if (!w) {
      runOnMainThread();
      return;
    }

    worker = w;
    const id = nextId++;
    w.onmessage = (ev) => {
      const d = ev.data as ApplyResponse | null;
      if (!d || d.id !== id) return; // not ours (or stale)
      if (d.ok) {
        const o = d.output as unknown;
        if (ArrayBuffer.isView(o)) {
          const out = new Uint8Array(o.buffer, o.byteOffset, o.byteLength);
          finish(() => resolve(out));
        } else {
          finish(() => reject(new PatchApplyError(WORKER_FAILED_MESSAGE)));
        }
      } else {
        finish(() => reject(new PatchApplyError(typeof d.message === 'string' && d.message ? d.message : WORKER_FAILED_MESSAGE)));
      }
    };
    const died = () => finish(() => reject(new PatchApplyError(WORKER_FAILED_MESSAGE)));
    w.onerror = (ev) => {
      // Keep the browser from also logging the error to the console as unhandled.
      (ev as { preventDefault?: () => void } | null)?.preventDefault?.();
      died();
    };
    w.onmessageerror = died;

    const request: ApplyRequest = { id, patchType, patch: patchBytes, rom: romBytes };
    try {
      w.postMessage(request, opts.transferPatch ? [patchBytes.buffer as ArrayBuffer] : []);
    } catch {
      // Could not even hand the data over (clone failed, out of memory): fall back to the old path.
      teardown();
      runOnMainThread();
    }
  });

  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      teardown();
      rejectOuter?.(new PatchApplyCancelled());
    },
  };
}
