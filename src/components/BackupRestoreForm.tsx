// src/components/BackupRestoreForm.tsx
'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Upload, CheckCircle2, XCircle } from 'lucide-react';

// The exact phrase the person has to type before Confirm enables, mirroring
// the same string the server itself requires in POST /api/admin/backup
// (belt-and-suspenders — see that route's own comment) — a plain "are you
// sure?" click is too easy to fire by reflex for something this destructive.
const CONFIRM_PHRASE = 'WIPE AND RESTORE';

interface ParsedBackup {
  formatVersion: number;
  generatedAt: string;
  generatedBy: { id: string; name: string | null } | null;
  counts: Record<string, number>;
  data: Record<string, any[]>;
}

interface RestoreResult {
  wiped: Record<string, number>;
  restored: Record<string, number>;
  patchesUnavailable: number;
  patchesInconclusive: number;
}

const TABLE_LABELS: Record<string, string> = {
  users: 'users',
  submissions: 'submissions',
  verifications: 'verification votes',
  trustEvents: 'trust events',
  hackFamilies: 'hack families',
  comments: 'comments',
  approvedEntries: 'approved entries',
  baseRoms: 'base ROMs',
  franchises: 'franchises',
  changeRequests: 'change requests',
};

export function BackupRestoreForm() {
  const [parsed, setParsed] = useState<ParsedBackup | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setFileError(null);
    setResult(null);
    setRestoreError(null);
    setParsed(null);
    setConfirming(false);
    setConfirmText('');
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      if (!json || typeof json !== 'object' || !json.data) {
        setFileError('This doesn\'t look like a HackHash full backup file.');
        return;
      }
      setParsed(json as ParsedBackup);
    } catch {
      setFileError('Couldn\'t read that file — is it a valid backup .json?');
    }
  }

  async function handleRestore() {
    if (!parsed || confirmText !== CONFIRM_PHRASE) return;
    setLoading(true);
    setRestoreError(null);
    try {
      const res = await fetch('/api/admin/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: parsed, confirm: CONFIRM_PHRASE }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRestoreError(data.error || 'Restore failed.');
      } else {
        setResult(data);
        setParsed(null);
        setConfirming(false);
      }
    } catch (err: any) {
      setRestoreError(err?.message || 'Restore failed.');
    } finally {
      setLoading(false);
    }
  }

  if (result) {
    return (
      <div className="flex items-start gap-2 text-sm text-status-approved">
        <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
        <div>
          <p className="font-medium">Restore complete.</p>
          <p className="text-text-secondary mt-1">
            {result.restored.users} users, {result.restored.submissions} submissions,{' '}
            {result.restored.verifications} verification votes, and everything else in the file restored.
          </p>
          {result.patchesUnavailable > 0 && (
            <p className="text-text-secondary mt-1">
              {result.patchesUnavailable} submission{result.patchesUnavailable === 1 ? '' : 's'} claimed a patch
              file that definitely wasn't found in patch storage — those were reset to "declared but not
              uploaded" rather than showing a broken download button.
            </p>
          )}
          {result.patchesInconclusive > 0 && (
            <p className="text-text-secondary mt-1">
              {result.patchesInconclusive} submission{result.patchesInconclusive === 1 ? '' : 's'} couldn't be
              confirmed either way against patch storage (not a clean "missing," something else went wrong
              checking) — left completely untouched rather than guessed at. Worth checking server logs, or
              running "Reconcile patch files" below.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {!parsed && (
        <label className="inline-flex items-center gap-2 text-sm font-medium text-text-primary border border-border rounded-md px-4 py-2 cursor-pointer hover:border-phosphor/50 hover:text-phosphor transition-colors w-fit">
          <Upload size={14} />
          Choose backup file
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
              e.target.value = '';
            }}
          />
        </label>
      )}

      {fileError && (
        <p className="flex items-center gap-1.5 text-sm text-status-rejected"><XCircle size={14} /> {fileError}</p>
      )}

      {parsed && (
        <div className="border border-border rounded-md p-4 bg-bg-base text-sm space-y-3">
          <div>
            <p className="text-text-secondary">
              Backup made {new Date(parsed.generatedAt).toLocaleString()}
              {parsed.generatedBy?.name ? ` by ${parsed.generatedBy.name}` : ''}.
            </p>
            <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-text-secondary">
              {Object.entries(TABLE_LABELS).map(([key, label]) =>
                parsed.counts[key] !== undefined ? (
                  <li key={key}><span className="font-mono text-text-primary">{parsed.counts[key]}</span> {label}</li>
                ) : null
              )}
            </ul>
          </div>

          {!confirming ? (
            <div className="flex items-center gap-2">
              <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
                Restore this backup
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setParsed(null)}>Cancel</Button>
            </div>
          ) : (
            <div className="space-y-2 border-t border-border pt-3">
              <p className="text-status-rejected text-xs">
                This will ERASE all current users, submissions, verifications, and everything else this backup
                covers, and replace it with the contents of this file. Type <span className="font-mono font-bold">{CONFIRM_PHRASE}</span> to confirm.
              </p>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={CONFIRM_PHRASE}
                className="w-full max-w-xs bg-bg-elevated border border-border rounded-md px-3 py-1.5 text-sm font-mono focus:outline-none focus:border-status-rejected"
              />
              <div className="flex items-center gap-2">
                <Button
                  variant="danger"
                  size="sm"
                  loading={loading}
                  disabled={confirmText !== CONFIRM_PHRASE}
                  onClick={handleRestore}
                >
                  Confirm — wipe and restore
                </Button>
                <Button variant="ghost" size="sm" onClick={() => { setConfirming(false); setConfirmText(''); }}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {restoreError && (
        <p className="flex items-center gap-1.5 text-sm text-status-rejected"><XCircle size={14} /> {restoreError}</p>
      )}
    </div>
  );
}
