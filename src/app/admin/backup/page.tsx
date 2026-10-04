// src/app/admin/backup/page.tsx
import React from 'react';
import { prisma } from '@/lib/prisma';
import { Download, AlertTriangle } from 'lucide-react';
import { BackupRestoreForm } from '@/components/BackupRestoreForm';
import { PatchReconcileButton } from '@/components/PatchReconcileButton';
import { PatchOrganizeButton } from '@/components/PatchOrganizeButton';

export const dynamic = 'force-dynamic';

async function getCurrentCounts() {
  const [users, submissions, verifications, trustEvents, hackFamilies, comments] = await Promise.all([
    prisma.user.count(),
    prisma.submission.count(),
    prisma.verification.count(),
    prisma.trustEvent.count(),
    prisma.hackFamily.count(),
    prisma.comment.count(),
  ]);
  return { users, submissions, verifications, trustEvents, hackFamilies, comments };
}

export default async function AdminBackupPage() {
  const counts = await getCurrentCounts().catch(() => null);

  return (
    <div className="space-y-10 max-w-3xl">
      <div>
        <h1 className="font-display text-2xl font-bold">Full database backup</h1>
        <p className="text-text-secondary text-sm mt-1">
          A complete, disaster-recovery-style snapshot — every user (role, trust score, ban state), every
          submission (including who submitted it and who uploaded its patch), every verification vote, trust
          history, comment, hack family, base ROM, and more. Separate from — and much broader than — the DAT
          export/import on the Import DAT tab, which is scoped to the public approved catalog only.
        </p>
      </div>

      <div className="border border-border rounded-lg p-6 bg-bg-elevated/50">
        <h2 className="font-display text-sm font-bold text-text-secondary uppercase tracking-wide mb-4">
          Current database
        </h2>
        {counts ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-6 text-sm">
            <div><span className="text-text-secondary">Users</span><div className="font-mono text-lg">{counts.users}</div></div>
            <div><span className="text-text-secondary">Submissions</span><div className="font-mono text-lg">{counts.submissions}</div></div>
            <div><span className="text-text-secondary">Verifications</span><div className="font-mono text-lg">{counts.verifications}</div></div>
            <div><span className="text-text-secondary">Trust events</span><div className="font-mono text-lg">{counts.trustEvents}</div></div>
            <div><span className="text-text-secondary">Hack families</span><div className="font-mono text-lg">{counts.hackFamilies}</div></div>
            <div><span className="text-text-secondary">Comments</span><div className="font-mono text-lg">{counts.comments}</div></div>
          </div>
        ) : (
          <p className="text-sm text-status-rejected mb-6">Couldn't load current counts.</p>
        )}
        <a
          href="/api/admin/backup"
          download
          className="inline-flex items-center gap-2 text-sm font-medium text-phosphor hover:text-phosphor-bright"
        >
          <Download size={14} /> Download full backup (.json)
        </a>
        <p className="text-xs text-text-secondary mt-2 max-w-xl">
          Patch FILES themselves aren't in this download — they live separately in patch storage (the
          bind-mounted host directory), which survives a database rebuild on its own. This is the database
          only. If patch storage isn't backed up some other way, it's worth doing that separately too.
        </p>
      </div>

      <div className="border border-border rounded-lg p-6 bg-bg-elevated/50">
        <h2 className="font-display text-sm font-bold text-text-secondary uppercase tracking-wide mb-2">
          Organize patch files
        </h2>
        <p className="text-sm text-text-secondary mb-2 max-w-xl">
          New uploads are filed as <span className="font-mono text-text-primary">Platform / Base ROM / Hack / file</span>.
          This moves patches uploaded before that into the same folders, and re-files any whose hack or base ROM has
          been renamed since. <span className="text-text-primary">Preview</span> first — it changes nothing.
        </p>
        <p className="text-xs text-text-secondary mb-4 max-w-xl">
          Safe to run any time and to repeat: files are never overwritten, a patch whose file can't be found is left
          alone and listed, and downloads keep working throughout.
        </p>
        <PatchOrganizeButton />
      </div>

      <div className="border border-status-pending/30 rounded-lg p-6 bg-status-pending/5">
        <h2 className="font-display text-sm font-bold text-status-pending uppercase tracking-wide mb-2">
          Reconcile patch files
        </h2>
        <p className="text-sm text-text-secondary mb-4 max-w-xl">
          Re-checks every submission that declares a patch but isn't currently marked as having one uploaded,
          against real patch storage, and reattaches any that are genuinely there. Safe to run any time — only
          ever reattaches a file it can definitively confirm, never guesses.
        </p>
        <PatchReconcileButton />
      </div>

      <div className="border border-status-rejected/30 rounded-lg p-6 bg-status-rejected/5">
        <h2 className="font-display text-sm font-bold text-status-rejected uppercase tracking-wide mb-2 flex items-center gap-2">
          <AlertTriangle size={14} /> Restore from a backup
        </h2>
        <p className="text-sm text-text-secondary mb-4 max-w-xl">
          Restoring WIPES every table this backup covers — every current user, submission, verification, comment,
          etc. — and replaces it with exactly what's in the file, with everyone's original IDs. This is meant for
          rebuilding an empty database after a real loss, not for merging into a database you still want to keep.
          There's no undo once you confirm.
        </p>
        <BackupRestoreForm />
      </div>
    </div>
  );
}
