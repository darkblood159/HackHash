'use client';

// src/app/admin/settings/page.tsx
//
// Small, single-purpose settings page — currently just the patch-uploads
// kill switch (src/lib/siteSettings.ts, src/app/api/admin/settings/route.ts).
// Same fetch-on-mount / POST-an-action client-page shape as the other admin
// pages (e.g. admin/base-roms/page.tsx), rather than a server component,
// so toggling reads back the fresh state immediately without a full page
// reload.
import React, { useEffect, useState } from 'react';
import { Settings, UploadCloud, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';

export default function AdminSettingsPage() {
  const [patchUploadsDisabled, setPatchUploadsDisabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/settings')
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((data) => setPatchUploadsDisabled(!!data.patchUploadsDisabled))
      .catch(() => setError('Failed to load settings'))
      .finally(() => setLoading(false));
  }, []);

  const toggle = async () => {
    if (patchUploadsDisabled === null) return;
    const next = !patchUploadsDisabled;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patchUploadsDisabled: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Failed to save');
        return;
      }
      setPatchUploadsDisabled(!!data.patchUploadsDisabled);
    } catch {
      setError('Network error — please try again');
    } finally {
      setSaving(false);
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
          Site-wide switches. Currently just the one below — more can be added here later.
        </p>
      </div>

      {error && <p className="text-sm text-status-rejected">{error}</p>}

      {loading || patchUploadsDisabled === null ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : (
        <div className="p-5 rounded-lg border border-border bg-bg-surface max-w-2xl">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-start gap-3">
              <UploadCloud size={18} className="text-phosphor shrink-0 mt-0.5" />
              <div>
                <p className="text-text-primary font-medium">Patch uploads</p>
                <p className="text-text-secondary text-sm mt-1 max-w-md">
                  Pauses attaching or replacing a patch <span className="text-text-primary">file</span> on any
                  submission — the upload control on a submission's page is replaced with a plain "Uploads are
                  temporarily disabled" notice instead, and the upload endpoint itself refuses new attempts the same
                  way.
                </p>
                <p className="text-text-muted text-xs mt-2 max-w-md">
                  Does not affect downloading an already-attached patch, or the in-browser "patch your ROM" feature —
                  both keep working normally while this is on. Removing an existing patch file is also unaffected.
                </p>
                <div className="flex items-center gap-1.5 mt-3 text-xs font-medium">
                  {patchUploadsDisabled ? (
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

            <Button
              variant={patchUploadsDisabled ? 'primary' : 'danger'}
              size="sm"
              loading={saving}
              onClick={toggle}
            >
              {patchUploadsDisabled ? 'Re-enable uploads' : 'Disable uploads'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
