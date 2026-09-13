'use client';

// src/components/PatchApplyButton.tsx
//
// Replaces the original PatchApplyPanel.tsx (section 2ay/2az) with a
// deliberately eye-catching button + modal, per direct feedback: the
// inline card version scrolled to (and visually blended into) a section
// buried in the page; this needed to look genuinely different from every
// other button on the page and behave more automatically. See
// CLAUDE_HANDOFF.txt section 2ba for the full reasoning.
//
// Flow is now hands-off by design: open the modal, drop a ROM (or it uses
// a cached one automatically), and it applies + verifies without any
// extra "Apply" click. A clean, verified result downloads itself
// immediately — no second click to get the file. Anything less than a
// clean, verified result (wrong base ROM, a patch that failed to apply,
// whatever the cause) never downloads on its own; the person always gets
// an explicit choice there instead, never a surprise file landing in
// their downloads folder that might be broken.

import React, { useCallback, useEffect, useState } from 'react';
import { Modal } from './ui/Modal';
import { ROMProcessor } from './ROMProcessor';
import { getCachedRom, cacheRom } from '@/lib/romCache';
import { applyPatch, isApplySupported, PatchApplyError } from '@/lib/patchApply';
import type { PatchTypeValue } from '@/lib/patchTypes';
import type { ROMFileInfo } from '@/types';
import { Wrench, CheckCircle2, AlertTriangle, Loader2, Download, RotateCcw } from 'lucide-react';

interface BaseRomInfo {
  sha1: string;
  name: string;
}
interface ExpectedOutputInfo {
  sha1: string | null;
  filename: string;
}

async function sha1HexOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function downloadBytes(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes as BlobPart]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type FlowState =
  | { phase: 'checking-cache' }
  | { phase: 'need-file' }
  | { phase: 'applying'; usingCached: boolean; mismatch: boolean }
  | { phase: 'done-verified' }
  | { phase: 'done-unverified'; bytes: Uint8Array }
  | { phase: 'done-error'; message: string };

export function PatchApplyButton({
  submissionId,
  patchType,
  baseRom,
  expectedOutput,
}: {
  submissionId: string;
  patchType: PatchTypeValue;
  baseRom: BaseRomInfo;
  expectedOutput: ExpectedOutputInfo;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<FlowState>({ phase: 'checking-cache' });

  const runApply = useCallback(
    async (romBytes: Uint8Array, romSha1: string, usingCached: boolean) => {
      const mismatch = romSha1.toLowerCase() !== baseRom.sha1.toLowerCase();
      setState({ phase: 'applying', usingCached, mismatch });
      try {
        const res = await fetch(`/api/submissions/${submissionId}/patch`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}) as { error?: string });
          throw new PatchApplyError(data.error || "Couldn't download the patch file — please try again.");
        }
        const patchBytes = new Uint8Array(await res.arrayBuffer());
        const patchedBytes = applyPatch(patchType, patchBytes, romBytes);
        const outputSha1 = await sha1HexOf(patchedBytes);
        const verified = !!expectedOutput.sha1 && outputSha1.toLowerCase() === expectedOutput.sha1.toLowerCase();
        if (verified) {
          // Clean, verified result — hand it over immediately, no extra
          // click. Anything less than this never auto-downloads (below).
          downloadBytes(patchedBytes, expectedOutput.filename);
          setState({ phase: 'done-verified' });
        } else {
          setState({ phase: 'done-unverified', bytes: patchedBytes });
        }
      } catch (err) {
        setState({
          phase: 'done-error',
          message:
            err instanceof PatchApplyError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'Something went wrong applying the patch — please try again.',
        });
      }
    },
    [submissionId, patchType, expectedOutput.sha1, expectedOutput.filename, baseRom.sha1]
  );

  const checkCacheAndProceed = useCallback(async () => {
    setState({ phase: 'checking-cache' });
    const cached = await getCachedRom(baseRom.sha1);
    if (cached) {
      void runApply(cached.bytes, cached.meta.sha1, true);
    } else {
      setState({ phase: 'need-file' });
    }
  }, [baseRom.sha1, runApply]);

  // Re-checks the cache (and re-applies automatically on a hit) every
  // time the modal opens, rather than only once — keeps this correct if
  // the person patches a different hack sharing this base ROM in another
  // tab and comes back, without needing a manual refresh.
  useEffect(() => {
    if (open) void checkCacheAndProceed();
  }, [open, checkCacheAndProceed]);

  const handleRomReady = useCallback(
    async (file: File, info: ROMFileInfo) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Cached regardless of whether it matches THIS hack's base ROM —
      // still the person's own file, might be exactly right for a
      // different hack later. Fire-and-forget; cacheRom never throws.
      void cacheRom(
        { sha1: info.sha1, filename: info.filename, size: info.fileSize, crc32: info.crc32, md5: info.md5 },
        bytes
      );
      void runApply(bytes, info.sha1, false);
    },
    [runApply]
  );

  if (!isApplySupported(patchType)) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-none border-2 border-highlight-bright bg-highlight px-3.5 py-2 text-xs font-bold uppercase tracking-wide text-white shadow-highlight transition-colors hover:bg-highlight-bright"
      >
        <Wrench size={13} />
        Patch this ROM
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title="Patch your ROM" maxWidthClassName="max-w-md">
        {state.phase === 'checking-cache' && (
          <p className="flex items-center gap-1.5 text-xs text-text-muted">
            <Loader2 size={12} className="animate-spin" />
            Checking for a cached copy of {baseRom.name}…
          </p>
        )}

        {state.phase === 'need-file' && (
          <div>
            <p className="mb-2 text-xs text-text-secondary">
              Drop your own copy of <span className="font-medium text-text-primary">{baseRom.name}</span> below
              — it&apos;s used right here in your browser and never uploaded anywhere.
            </p>
            <ROMProcessor onFileReady={handleRomReady} showUseButton={false} label="Drop your ROM here" />
          </div>
        )}

        {state.phase === 'applying' && (
          <div className="space-y-2 text-xs">
            {state.usingCached && <p className="text-text-muted">Using your cached copy of {baseRom.name}…</p>}
            {state.mismatch && (
              <p className="flex items-start gap-1.5 text-status-pending">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                This doesn&apos;t look like the expected base ROM — trying anyway, but it may not come out right.
              </p>
            )}
            <p className="flex items-center gap-1.5 text-text-secondary">
              <Loader2 size={12} className="animate-spin text-phosphor" />
              Applying the patch…
            </p>
          </div>
        )}

        {state.phase === 'done-verified' && (
          <div className="space-y-3">
            <p className="flex items-start gap-1.5 text-xs text-status-approved">
              <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
              Patched and verified — your download should start automatically. If it didn&apos;t, check your
              browser&apos;s download prompt.
            </p>
            <button
              onClick={checkCacheAndProceed}
              className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary"
            >
              <RotateCcw size={11} />
              Patch another copy
            </button>
          </div>
        )}

        {state.phase === 'done-unverified' && (
          <div className="space-y-3">
            <p className="flex items-start gap-1.5 text-xs text-status-pending">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              This didn&apos;t come out matching what&apos;s expected for this hack — the base ROM you used may
              be the wrong revision, or something else went sideways. You can still download it, but check it
              carefully before trusting it.
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                onClick={() => downloadBytes(state.bytes, expectedOutput.filename)}
                className="flex items-center gap-1.5 rounded-md bg-bg-elevated px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-hover"
              >
                <Download size={12} />
                Download anyway
              </button>
              <button
                onClick={() => setState({ phase: 'need-file' })}
                className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary"
              >
                <RotateCcw size={11} />
                Try a different ROM
              </button>
            </div>
          </div>
        )}

        {state.phase === 'done-error' && (
          <div className="space-y-3">
            <p className="flex items-start gap-1.5 text-xs text-status-rejected">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              {state.message}
            </p>
            <button
              onClick={() => setState({ phase: 'need-file' })}
              className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary"
            >
              <RotateCcw size={11} />
              Try again
            </button>
          </div>
        )}
      </Modal>
    </>
  );
}
