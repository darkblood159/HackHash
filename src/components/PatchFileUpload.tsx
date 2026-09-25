'use client';

// src/components/PatchFileUpload.tsx
//
// Upload/replace/remove the actual patch FILE for a submission — distinct
// from PatchDropzone (SubmitForm.tsx / ChangeRequestSection.tsx), which
// only ever computes a hash locally to fill in form fields and explicitly
// tells the user "the file itself is never uploaded". This component's
// whole job is the opposite: it DOES upload real bytes, to
// POST /api/submissions/[id]/patch (and DELETE to remove).
//
// Deliberately NOT built on PatchDropzone: reusing it would mean either
// forking its own hardcoded, user-facing "the file itself is never
// uploaded" promise into something conditional, or bolting an opt-in
// "actually keep the file this time" prop onto a component that stays
// simple specifically because it never has to do that. The SHA-1 hashing
// itself (sha1Hex, patchTypes.ts) IS shared with PatchDropzone, though —
// they started as two near-identical local copies, consolidated into one
// after a real bug (crypto.subtle silently unavailable outside a secure
// context, latent in both) turned out to need fixing in both places at
// once — see CLAUDE_HANDOFF.txt section 2aw.
//
// `canManage` is computed SERVER-SIDE by the page (canManagePatchFile,
// src/lib/patchPermissions.ts) and only controls what this component
// SHOWS. It is not a security boundary by itself — the API route runs the
// exact same check independently and is the actual authority; a manually
// crafted request with canManage bypassed client-side still gets a real
// 403 from the route.
//
// ARCHIVE SUPPORT (.zip/.gz/.7z/.rar): reuses src/lib/archiveExtract.ts
// completely as-is — the same module ROMProcessor.tsx already uses to let
// a submitter drop a compressed ROM archive instead of extracting it
// first. Extraction happens entirely client-side; what actually gets
// uploaded is the one chosen file's real extracted bytes, wrapped in a
// synthetic File with its own in-archive name — from that point on it
// flows through the exact same stageFile()/upload() path as a directly-
// dropped patch file always has, so nothing server-side needed to change
// at all: the upload route already validates a patch by sniffing the
// actual bytes it receives (detectPatchFormat, patchValidation.ts), never
// by trusting a filename or extension. The only new client-side decision
// is WHICH file inside the archive is the patch — auto-picked when
// unambiguous (pickAutoPatchCandidate, archiveExtract.ts), or left to the
// person via the PatchArchivePicker component further below when it isn't.
import React, { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { clsx } from 'clsx';
import { Upload, FileCheck, AlertCircle, Loader2, ShieldAlert, Trash2, UploadCloud, ListChecks } from 'lucide-react';
import { patchTypeFromFilename, patchTypeLabel, sha1Hex, HashingUnavailableError } from '@/lib/patchTypes';
import { PATCH_UPLOADS_DISABLED_MESSAGE } from '@/lib/patchUploadState';
import {
  classifyArchive, readZipCandidates, read7zCandidates, readGzipFile, pickAutoPatchCandidate,
  type ArchiveCandidate,
} from '@/lib/archiveExtract';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

interface Staged {
  file: File;
  sha1: string;
  guessedType: string | null;
  // Set when this file was extracted from an archive rather than dropped
  // directly — shown in the staged card ("extracted from X.zip") same as
  // ROMProcessor.tsx's FileCard already does for the ROM side, so it's
  // never ambiguous which file is about to actually be uploaded.
  sourceArchiveName?: string;
}

// Shown instead of the normal drop zone when an archive has more than one
// plausible file inside it and pickAutoPatchCandidate (archiveExtract.ts)
// couldn't confidently pick one on its own — same shape of problem
// ROMProcessor.tsx's own ArchivePickerCard solves for ROMs, adapted to
// this component's smaller/compact card style rather than duplicated
// wholesale (that one also renders progress/hash cards for a whole LIST
// of files; this component only ever stages one).
interface PendingPatchArchive {
  archiveFile: File;
  candidates: ArchiveCandidate[];
  extract: (path: string, onProgress?: (percent: number | null) => void) => Promise<Uint8Array>;
}

const MAX_PATCH_ARCHIVE_CANDIDATES_SHOWN = 50;

function PatchArchivePicker({
  pending,
  onChoose,
  onCancel,
}: {
  pending: PendingPatchArchive;
  onChoose: (candidate: ArchiveCandidate) => void;
  onCancel: () => void;
}) {
  const [selectedPath, setSelectedPath] = useState(pending.candidates[0]?.path ?? '');
  const shown = pending.candidates.slice(0, MAX_PATCH_ARCHIVE_CANDIDATES_SHOWN);
  const hiddenCount = pending.candidates.length - shown.length;

  return (
    <div className="space-y-2 rounded-lg border border-border bg-bg-elevated p-3">
      <div className="flex items-center gap-2 text-xs text-text-secondary">
        <ListChecks size={12} className="shrink-0 text-phosphor" />
        <span className="font-mono text-text-primary truncate flex-1">{pending.archiveFile.name}</span>
        <span className="text-text-muted font-mono shrink-0">{pending.candidates.length} files</span>
      </div>
      <p className="text-xs text-text-secondary">
        This archive has more than one file — pick the one that&apos;s the actual patch.
      </p>
      <div className="space-y-1 max-h-48 overflow-y-auto">
        {shown.map((c) => (
          <button
            key={c.path}
            type="button"
            onClick={() => setSelectedPath(c.path)}
            className={clsx(
              'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors',
              selectedPath === c.path
                ? 'bg-phosphor/10 border border-phosphor/40'
                : 'border border-transparent hover:bg-bg-surface'
            )}
          >
            <span className="truncate flex-1 font-mono text-xs text-text-primary">{c.path}</span>
            {patchTypeFromFilename(c.basename) && (
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-phosphor/15 text-phosphor">
                looks like {patchTypeFromFilename(c.basename)}
              </span>
            )}
            <span className="shrink-0 text-[10px] text-text-muted font-mono">
              {c.size != null ? formatBytes(c.size) : '—'}
            </span>
          </button>
        ))}
      </div>
      {hiddenCount > 0 && (
        <p className="text-[10px] text-text-muted">+{hiddenCount} more file{hiddenCount === 1 ? '' : 's'} not shown.</p>
      )}
      <div className="flex gap-2">
        <button
          onClick={onCancel}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-bg-surface"
        >
          Cancel
        </button>
        <button
          onClick={() => {
            const candidate = pending.candidates.find((c) => c.path === selectedPath);
            if (candidate) onChoose(candidate);
          }}
          disabled={!selectedPath}
          className="rounded-md bg-phosphor px-3 py-1.5 text-xs font-medium text-bg-base hover:bg-phosphor/90 disabled:opacity-50"
        >
          Use this file
        </button>
      </div>
    </div>
  );
}

// Mirrors the `patchTypeMismatch` object the upload route now sends
// alongside `error` on a 422 declared-vs-detected mismatch — see
// route.ts's own comment on that field. Kept local (not imported from
// patchTypes.ts) since this is just an echo of two already-known
// PatchTypeValue strings, not a new concept this component needs a
// shared type for.
interface PatchTypeMismatch {
  declaredType: string;
  detectedType: string;
}

export function PatchFileUpload({
  submissionId,
  canManage,
  hasFile,
  uploadsDisabled = false,
}: {
  submissionId: string;
  canManage: boolean;
  hasFile: boolean;
  // Server-computed (src/lib/siteSettings.ts, via the page), same
  // "controls what's shown, isn't the actual boundary" relationship
  // `canManage` already has to the real rule — the route enforces this
  // switch independently regardless of what this prop says. Only ever
  // hides the drop-to-upload/replace zone; removing an already-attached
  // file is untouched, since clearing one isn't "uploading" it.
  uploadsDisabled?: boolean;
}) {
  const router = useRouter();
  const [dragging, setDragging] = useState(false);
  const [staged, setStaged] = useState<Staged | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only ever set from the upload route's own `patchTypeMismatch` field —
  // see the "Use {detectedType} instead" button below. Cleared any time a
  // fresh attempt starts, same reset points as `error` itself, so it can
  // never linger and describe an attempt that's no longer current.
  const [mismatch, setMismatch] = useState<PatchTypeMismatch | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  // Archive-handling state — mirrors ROMProcessor.tsx's own phase/progress
  // tracking, scoped down to this component's simpler "stage exactly one
  // file" job (no list of files, no per-entry keys needed). `archivePhase`
  // is purely descriptive text/UI state; `busy` (above) remains the one
  // real gate on the dropzone/buttons throughout, same as before this
  // feature existed.
  const [archivePhase, setArchivePhase] = useState<'reading' | 'extracting' | null>(null);
  const [archiveProgress, setArchiveProgress] = useState<number | null>(null);
  const [pendingArchive, setPendingArchive] = useState<PendingPatchArchive | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const stageFile = useCallback(async (file: File, sourceArchiveName?: string) => {
    setError(null);
    setMismatch(null);
    setBusy(true);
    try {
      const sha1 = await sha1Hex(file);
      setStaged({ file, sha1, guessedType: patchTypeFromFilename(file.name), sourceArchiveName });
    } catch (err) {
      // Logged, not just swallowed — a generic on-screen message is fine
      // for the person, but silently discarding the real error made this
      // exact bug unnecessarily hard to diagnose from a report alone.
      console.error('[PatchFileUpload] failed to hash file locally:', err);
      setError(
        err instanceof HashingUnavailableError
          ? err.message
          : "Couldn't read that file locally — please try again."
      );
    } finally {
      setBusy(false);
    }
  }, []);

  // Handles a raw dropped/selected file, extracting it first if it's a
  // supported archive (.zip/.gz/.7z/.rar) — see the file-header comment
  // for why this needs no server-side changes at all. A non-archive file
  // (or one this project's list doesn't try to auto-extract) falls
  // straight through to stageFile exactly as before this feature existed.
  const processFile = useCallback(
    async (file: File) => {
      setError(null);
      setMismatch(null);
      setPendingArchive(null);

      const format = classifyArchive(file.name);

      if (format.kind === 'unsupported') {
        setError(
          `${format.label} archives can't be auto-extracted yet — extract the patch file yourself, then drop it in directly.`
        );
        return;
      }

      if (format.kind === 'none') {
        await stageFile(file);
        return;
      }

      setBusy(true);
      setArchivePhase(format.kind === 'sevenzip' ? 'reading' : 'extracting');
      // 7z-wasm's own load+list step has no percent-complete signal at
      // all (see archiveExtract.ts's "7-ZIP / RAR" section) — null renders
      // as an indeterminate pulse below rather than a fabricated number,
      // same convention ROMProcessor.tsx already uses for the same reason.
      setArchiveProgress(format.kind === 'sevenzip' ? null : 0);

      try {
        if (format.kind === 'gzip') {
          const result = await readGzipFile(file);
          if (!result.ok) {
            setError(result.error);
            return;
          }
          const innerFile = new File([new Uint8Array(result.bytes)], result.innerName, {
            lastModified: file.lastModified,
          });
          await stageFile(innerFile, file.name);
          return;
        }

        const result =
          format.kind === 'zip' ? await readZipCandidates(file) : await read7zCandidates(file, format.label);
        if (!result.ok) {
          setError(result.error);
          return;
        }

        setArchivePhase('extracting');
        setArchiveProgress(format.kind === 'sevenzip' ? null : 0);

        // Auto-pick only when unambiguous (pickAutoPatchCandidate's own
        // comment has the exact tiers) — anything less certain shows
        // PatchArchivePicker instead of guessing, since guessing wrong
        // here means silently uploading the wrong file as this
        // submission's patch.
        const chosen = pickAutoPatchCandidate(result.candidates);
        if (!chosen) {
          setPendingArchive({
            archiveFile: file,
            candidates: [...result.candidates].sort(
              (a, b) =>
                Number(patchTypeFromFilename(b.basename) !== null) -
                  Number(patchTypeFromFilename(a.basename) !== null) || (b.size ?? 0) - (a.size ?? 0)
            ),
            extract: result.extract,
          });
          return;
        }

        const bytes = await result.extract(chosen.path, (percent) => setArchiveProgress(percent));
        // Forces a concrete ArrayBuffer-backed copy rather than passing
        // the library's own return value straight through — same reason
        // ROMProcessor.tsx's own extraction call sites do this (see that
        // file's comment): File's BlobPart type requires it, and real
        // browsers throw at runtime on a SharedArrayBuffer-backed view.
        const innerFile = new File([new Uint8Array(bytes)], chosen.basename, { lastModified: file.lastModified });
        await stageFile(innerFile, file.name);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't extract this file — please try again.");
      } finally {
        setArchivePhase(null);
        setArchiveProgress(null);
        setBusy(false);
      }
    },
    [stageFile]
  );

  // Called when the person picks a file from PatchArchivePicker after an
  // ambiguous archive. Same extract-then-stage shape as the auto-pick
  // path in processFile above, just triggered by a click instead of
  // running automatically.
  const chooseArchiveCandidate = useCallback(
    async (candidate: ArchiveCandidate) => {
      if (!pendingArchive) return;
      const { archiveFile, extract } = pendingArchive;
      setPendingArchive(null);
      setBusy(true);
      setArchivePhase('extracting');
      setArchiveProgress(0);
      try {
        const bytes = await extract(candidate.path, (percent) => setArchiveProgress(percent));
        const innerFile = new File([new Uint8Array(bytes)], candidate.basename, {
          lastModified: archiveFile.lastModified,
        });
        await stageFile(innerFile, archiveFile.name);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't extract this file — please try again.");
      } finally {
        setArchivePhase(null);
        setArchiveProgress(null);
        setBusy(false);
      }
    },
    [pendingArchive, stageFile]
  );

  // Exactly one patch file per submission — same "take the unambiguous
  // first one" handling as PatchDropzone, applied to a situation where
  // there's genuinely nowhere for a second one to go.
  const handleFiles = useCallback(
    (list: FileList | null) => {
      if (!list || list.length === 0) return;
      processFile(list[0]);
    },
    [processFile]
  );

  const upload = useCallback(async () => {
    if (!staged) return;
    setBusy(true);
    setError(null);
    setMismatch(null);
    try {
      const formData = new FormData();
      formData.append('file', staged.file);
      const res = await fetch(`/api/submissions/${submissionId}/patch`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || 'Upload failed — please try again.');
        // Present when this 422 is specifically a declared-vs-detected
        // patch type mismatch (see route.ts) — drives the "Use
        // {detectedType} instead" button below. Absent for every other
        // error shape (wrong sha1, unrecognized format, size limit,
        // permission, etc.), which still just show `error` as before.
        if (data?.patchTypeMismatch?.declaredType && data?.patchTypeMismatch?.detectedType) {
          setMismatch(data.patchTypeMismatch as PatchTypeMismatch);
        }
        return;
      }
      setStaged(null);
      router.refresh(); // re-fetches the submission server-side — patchUploadedAt etc. are now current
    } catch {
      setError('Upload failed — please check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }, [staged, submissionId, router]);

  // Fixes the exact mismatch the upload route just reported by correcting
  // the submission's OWN declared patchType to whatever the file's real
  // bytes are, then retrying the same still-staged upload — instead of
  // making the person go find the edit panel / change-request form
  // themselves just to clear or fix one field. Uses the existing PATCH
  // /api/submissions/[id] endpoint (already accepts patchType, per
  // src/lib/fieldLimits.ts) rather than adding a new endpoint for this.
  //
  // NOT gated on a client-computed permission check — whoever can reach
  // this component at all can already reach the real fix manually via the
  // edit panel or a change request; this is a convenience shortcut for
  // that same action, and PATCH /api/submissions/[id] is the actual
  // authority regardless. A viewer who CAN manage the patch FILE but
  // ISN'T the owner-while-PENDING or an admin (a VERIFIER specifically —
  // canManagePatchFile.ts grants file management to admins and verifiers
  // alike, but the PATCH route's own edit permission is owner-while-
  // PENDING-or-admin only, not verifier) will get a real 403 back here;
  // handled below by surfacing that failure plainly rather than assuming
  // success, same as every other network call in this component.
  const useDetectedTypeAndRetry = useCallback(async () => {
    if (!mismatch) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/submissions/${submissionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // patchType is per-version metadata, not a shared/family field
        // (CLAUDE_HANDOFF.txt section 2f) — applyToAllVersions wouldn't
        // do anything either way here, but false is the more honest
        // value to send for a single-field metadata correction like this.
        body: JSON.stringify({ patchType: mismatch.detectedType, applyToAllVersions: false }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          `Couldn't update the declared patch type automatically (${data?.error || 'unknown error'}). ` +
            'An admin can change it from the edit panel, or clear that field and re-upload.'
        );
        return;
      }
      setMismatch(null);
      await upload();
    } catch {
      setError(
        "Couldn't update the declared patch type automatically — please check your connection and try again."
      );
    } finally {
      setBusy(false);
    }
  }, [mismatch, submissionId, upload]);

  const remove = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/submissions/${submissionId}/patch`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || 'Remove failed — please try again.');
        return;
      }
      setConfirmingRemove(false);
      router.refresh();
    } catch {
      setError('Remove failed — please check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }, [submissionId, router]);

  if (!canManage) {
    return hasFile ? (
      <p className="flex items-center gap-1.5 text-xs text-text-muted">
        <ShieldAlert size={12} className="shrink-0" />
        A patch file is attached — only an admin or verifier can replace or remove it.
      </p>
    ) : (
      <p className="text-xs text-text-muted">No patch file uploaded yet.</p>
    );
  }

  return (
    <div className="space-y-2">
      {uploadsDisabled && !staged ? (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-bg-elevated px-4 py-4 text-center text-sm text-text-muted">
          <UploadCloud size={16} className="shrink-0" />
          <span>{PATCH_UPLOADS_DISABLED_MESSAGE}</span>
        </div>
      ) : pendingArchive ? (
        <PatchArchivePicker
          pending={pendingArchive}
          onChoose={chooseArchiveCandidate}
          onCancel={() => setPendingArchive(null)}
        />
      ) : archivePhase ? (
        <div className="flex items-center gap-2 rounded-lg border-2 border-dashed border-border bg-bg-elevated px-4 py-4 text-center text-sm text-text-secondary">
          <Loader2 size={16} className="shrink-0 animate-spin text-phosphor" />
          <span>
            {archivePhase === 'reading' ? 'Reading archive…' : 'Extracting…'}
            {archiveProgress !== null && ` ${Math.round(archiveProgress)}%`}
          </span>
        </div>
      ) : !staged ? (
        <div
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            handleFiles(e.dataTransfer.files);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onClick={() => inputRef.current?.click()}
          className={clsx(
            'relative flex cursor-pointer select-none flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-4 text-center transition-all',
            dragging ? 'border-phosphor bg-phosphor/5' : 'border-border hover:border-phosphor/50 hover:bg-bg-elevated'
          )}
        >
          <div className="flex items-center gap-3">
            {busy ? (
              <Loader2 size={16} className="shrink-0 animate-spin text-phosphor" />
            ) : (
              <Upload size={16} className={clsx('shrink-0', dragging ? 'text-phosphor' : 'text-text-muted')} />
            )}
            <p className="text-sm font-medium text-text-primary">
              {hasFile
                ? dragging
                  ? 'Drop to stage the replacement'
                  : 'Drop a replacement patch file, or click to browse'
                : dragging
                  ? 'Drop to stage the patch'
                  : 'Drop the patch file here, or click to browse'}
            </p>
          </div>
          <p className="text-xs text-text-muted">.zip, .rar, and .7z are unpacked automatically</p>
          <input ref={inputRef} type="file" className="hidden" onChange={(e) => handleFiles(e.target.files)} />
        </div>
      ) : (
        <div className="space-y-2 rounded-lg border border-border bg-bg-elevated p-3">
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            <FileCheck size={12} className="shrink-0 text-phosphor" />
            <span className="font-mono text-text-primary">{staged.file.name}</span>
            {staged.guessedType && <span>— looks like {staged.guessedType}</span>}
          </div>
          {staged.sourceArchiveName && (
            <p className="text-[10px] text-text-muted pl-[18px]">extracted from {staged.sourceArchiveName}</p>
          )}
          <div className="flex gap-2">
            <button
              onClick={upload}
              disabled={busy}
              className="rounded-md bg-phosphor px-3 py-1.5 text-xs font-medium text-bg-base hover:bg-phosphor/90 disabled:opacity-50"
            >
              {busy ? 'Uploading…' : hasFile ? 'Confirm replace' : 'Confirm upload'}
            </button>
            <button
              onClick={() => setStaged(null)}
              disabled={busy}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-bg-surface disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {hasFile &&
        !staged &&
        !pendingArchive &&
        !archivePhase &&
        (confirmingRemove ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-text-secondary">Remove this patch file?</span>
            <button
              onClick={remove}
              disabled={busy}
              className="font-medium text-status-rejected hover:underline disabled:opacity-50"
            >
              {busy ? 'Removing…' : 'Yes, remove it'}
            </button>
            <button onClick={() => setConfirmingRemove(false)} disabled={busy} className="text-text-muted hover:underline">
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmingRemove(true)}
            className="flex items-center gap-1.5 text-xs text-text-muted hover:text-status-rejected"
          >
            <Trash2 size={12} />
            Remove patch file
          </button>
        ))}

      {error && (
        <div className="space-y-1.5 text-xs text-status-rejected">
          <div className="flex items-center gap-2">
            <AlertCircle size={12} className="shrink-0" />
            <span>{error}</span>
          </div>
          {mismatch && (
            <button
              onClick={useDetectedTypeAndRetry}
              disabled={busy}
              className="rounded-md border border-status-rejected/40 px-2.5 py-1 text-xs font-medium text-status-rejected hover:bg-status-rejected/10 disabled:opacity-50"
            >
              {busy ? 'Updating…' : `Use ${patchTypeLabel(mismatch.detectedType)} instead of ${patchTypeLabel(mismatch.declaredType)} & upload`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
