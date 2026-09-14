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
import React, { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { clsx } from 'clsx';
import { Upload, FileCheck, AlertCircle, Loader2, ShieldAlert, Trash2 } from 'lucide-react';
import { patchTypeFromFilename, sha1Hex, HashingUnavailableError } from '@/lib/patchTypes';

interface Staged {
  file: File;
  sha1: string;
  guessedType: string | null;
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
}: {
  submissionId: string;
  canManage: boolean;
  hasFile: boolean;
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
  const inputRef = useRef<HTMLInputElement>(null);

  const stageFile = useCallback(async (file: File) => {
    setError(null);
    setMismatch(null);
    setBusy(true);
    try {
      const sha1 = await sha1Hex(file);
      setStaged({ file, sha1, guessedType: patchTypeFromFilename(file.name) });
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

  // Exactly one patch file per submission — same "take the unambiguous
  // first one" handling as PatchDropzone, applied to a situation where
  // there's genuinely nowhere for a second one to go.
  const handleFiles = useCallback(
    (list: FileList | null) => {
      if (!list || list.length === 0) return;
      stageFile(list[0]);
    },
    [stageFile]
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
      {!staged ? (
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
            'relative flex cursor-pointer select-none items-center justify-center gap-3 rounded-lg border-2 border-dashed px-4 py-4 text-center transition-all',
            dragging ? 'border-phosphor bg-phosphor/5' : 'border-border hover:border-phosphor/50 hover:bg-bg-elevated'
          )}
        >
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
          <input ref={inputRef} type="file" className="hidden" onChange={(e) => handleFiles(e.target.files)} />
        </div>
      ) : (
        <div className="space-y-2 rounded-lg border border-border bg-bg-elevated p-3">
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            <FileCheck size={12} className="shrink-0 text-phosphor" />
            <span className="font-mono text-text-primary">{staged.file.name}</span>
            {staged.guessedType && <span>— looks like {staged.guessedType}</span>}
          </div>
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
              {busy ? 'Updating…' : `Use ${mismatch.detectedType} instead of ${mismatch.declaredType} & upload`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
