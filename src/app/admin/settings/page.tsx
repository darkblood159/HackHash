'use client';

// src/app/admin/settings/page.tsx
//
// Small settings page — currently two kill switches, patch uploads and bulk
// submit (src/lib/siteSettings.ts, src/app/api/admin/settings/route.ts).
// Same fetch-on-mount / POST-an-action client-page shape as the other admin
// pages (e.g. admin/base-roms/page.tsx), rather than a server component,
// so toggling reads back the fresh state immediately without a full page
// reload.
import React, { useEffect, useState } from 'react';
import { Settings, UploadCloud, ListPlus, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';

// One switch card. Both switches render through this so they can't drift
// apart visually; the patch-uploads copy below is exactly what that card said
// before this was extracted.
function SwitchCard({
  icon,
  title,
  description,
  note,
  disabled,
  saving,
  onToggle,
  enableLabel,
  disableLabel,
}: {
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  note: string;
  disabled: boolean;
  saving: boolean;
  onToggle: () => void;
  enableLabel: string;
  disableLabel: string;
}) {
  return (
    <div className="p-5 rounded-lg border border-border bg-bg-surface max-w-2xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <span className="text-phosphor shrink-0 mt-0.5">{icon}</span>
          <div>
            <p className="text-text-primary font-medium">{title}</p>
            <p className="text-text-secondary text-sm mt-1 max-w-md">{description}</p>
            <p className="text-text-muted text-xs mt-2 max-w-md">{note}</p>
            <div className="flex items-center gap-1.5 mt-3 text-xs font-medium">
              {disabled ? (
                <span className="flex items-center gap-1.5 text-status-rejected">
                  <AlertCircle size={12} /> Currently disabled
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-phosphor">
                  <CheckCircle2 size={12} /> Currently enabled
                </span>
              )}
            </div>
          </div>
        </div>

        <Button variant={disabled ? 'primary' : 'danger'} size="sm" loading={saving} onClick={onToggle}>
          {disabled ? enableLabel : disableLabel}
        </Button>
      </div>
    </div>
  );
}

export default function AdminSettingsPage() {
  const [patchUploadsDisabled, setPatchUploadsDisabled] = useState<boolean | null>(null);
  const [bulkSubmitDisabled, setBulkSubmitDisabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<'patchUploadsDisabled' | 'bulkSubmitDisabled' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/settings')
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((data) => {
        setPatchUploadsDisabled(!!data.patchUploadsDisabled);
        setBulkSubmitDisabled(!!data.bulkSubmitDisabled);
      })
      .catch(() => setError('Failed to load settings'))
      .finally(() => setLoading(false));
  }, []);

  // Flips one switch. Sends only that key; the server applies whichever it is
  // given and answers with both current values, which is what's rendered.
  const toggle = async (key: 'patchUploadsDisabled' | 'bulkSubmitDisabled', current: boolean | null) => {
    if (current === null) return;
    setSaving(key);
    setError(null);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: !current }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Failed to save');
        return;
      }
      setPatchUploadsDisabled(!!data.patchUploadsDisabled);
      setBulkSubmitDisabled(!!data.bulkSubmitDisabled);
    } catch {
      setError('Network error — please try again');
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl font-bold flex items-center gap-2">
          <Settings size={20} className="text-phosphor" />
          Site settings
        </h1>
        <p className="text-text-secondary text-sm mt-1 max-w-2xl">
          Site-wide switches. More can be added here later.
        </p>
      </div>

      {error && <p className="text-sm text-status-rejected">{error}</p>}

      {loading || patchUploadsDisabled === null || bulkSubmitDisabled === null ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : (
        <div className="space-y-4">
          <SwitchCard
            icon={<UploadCloud size={18} />}
            title="Patch uploads"
            description={
              <>
                Pauses attaching or replacing a patch <span className="text-text-primary">file</span> on any
                submission — the upload control on a submission's page is replaced with a plain "Uploads are
                temporarily disabled" notice instead, and the upload endpoint itself refuses new attempts the same
                way.
              </>
            }
            note={
              'Does not affect downloading an already-attached patch, or the in-browser "patch your ROM" feature — ' +
              'both keep working normally while this is on. Removing an existing patch file is also unaffected.'
            }
            disabled={patchUploadsDisabled}
            saving={saving === 'patchUploadsDisabled'}
            onToggle={() => toggle('patchUploadsDisabled', patchUploadsDisabled)}
            enableLabel="Re-enable uploads"
            disableLabel="Disable uploads"
          />
          <SwitchCard
            icon={<ListPlus size={18} />}
            title="Bulk submit"
            description={
              <>
                Pauses the <span className="text-text-primary">submit several versions at once</span> screen: starting
                a batch, sending a version under one, and the pre-submit check all refuse with a plain "temporarily
                disabled" notice, and the screen itself shows that message instead of the form.
              </>
            }
            note={
              'Submitting versions one at a time is unaffected, and so is uploading a patch to an existing ' +
              'submission the ordinary way (that has its own switch above). Entries already created in a batch are ' +
              'not touched.'
            }
            disabled={bulkSubmitDisabled}
            saving={saving === 'bulkSubmitDisabled'}
            onToggle={() => toggle('bulkSubmitDisabled', bulkSubmitDisabled)}
            enableLabel="Re-enable bulk submit"
            disableLabel="Disable bulk submit"
          />
        </div>
      )}
    </div>
  );
}
