// src/workers/patchApply.worker.ts
//
// Runs patchApply.ts's applyPatch() off the page's main thread, so a large or
// hostile patch (a BPS/UPS header can declare an output up to MAX_OUTPUT_BYTES,
// 512 MiB, and applying it can loop for seconds) can no longer freeze the tab.
// The decoding logic itself is NOT duplicated or changed: this file only
// receives bytes, calls the same function the page used to call directly, and
// sends back either the output or an error message.
//
// One request per worker: the page creates a fresh worker for each apply and
// terminates it afterwards (patchApplyClient.ts), which is what actually frees
// a large output buffer and is what makes Cancel work.
//
// Everything stays in the browser: no network access, nothing is uploaded.
import { applyPatch } from '@/lib/patchApply';
import type { ApplyRequest, ApplyResponse } from '@/lib/patchApplyProtocol';

// `self` is typed for the window in this project's tsconfig (no "webworker" lib),
// so describe the little of it this file uses.
interface WorkerScope {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage(message: ApplyResponse, transfer: ArrayBuffer[]): void;
}
const scope = self as unknown as WorkerScope;

function isRequest(d: unknown): d is ApplyRequest {
  const r = d as Partial<ApplyRequest> | null;
  return (
    !!r &&
    typeof r.id === 'number' &&
    typeof r.patchType === 'string' &&
    ArrayBuffer.isView(r.patch) &&
    ArrayBuffer.isView(r.rom)
  );
}

scope.onmessage = (e) => {
  const data = e.data;
  if (!isRequest(data)) {
    const id = typeof (data as { id?: unknown } | null)?.id === 'number' ? (data as { id: number }).id : -1;
    scope.postMessage({ id, ok: false, message: 'The patch request was malformed.' }, []);
    return;
  }
  try {
    const patch = new Uint8Array(data.patch.buffer, data.patch.byteOffset, data.patch.byteLength);
    const rom = new Uint8Array(data.rom.buffer, data.rom.byteOffset, data.rom.byteLength);
    const output = applyPatch(data.patchType as Parameters<typeof applyPatch>[0], patch, rom);
    // Hand the output over without copying it (it can be hundreds of MiB).
    scope.postMessage({ id: data.id, ok: true, output }, [output.buffer as ArrayBuffer]);
  } catch (err) {
    // applyPatch already turns everything into a PatchApplyError with a readable
    // message; this only guards the unexpected (e.g. a failure while posting).
    const message = err instanceof Error && err.message ? err.message : 'Couldn\'t apply the patch.';
    scope.postMessage({ id: data.id, ok: false, message }, []);
  }
};
