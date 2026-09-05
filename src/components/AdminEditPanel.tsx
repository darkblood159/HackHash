'use client';

// src/components/AdminEditPanel.tsx
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from './ui/Button';
import { Pencil, AlertTriangle } from 'lucide-react';
import { PLATFORMS, PLATFORM_LABELS } from '@/types';
import { MappingsSection, type MappingValues } from './MappingsSection';
import { MAPPING_FIELD_KEYS } from '@/lib/mappingFields';
import { TagsEditor } from './TagsEditor';
import { LanguagePicker } from './LanguagePicker';
import { TRANSLATION_TRIGGER_SLUGS } from '@/lib/tags';
import { describeValidationError } from '@/lib/fieldLabels';
import { FamilyPicker, type SelectedFamily } from './FamilyPicker';
import { BaseRomPicker, type SelectedBaseRom } from './BaseRomPicker';

interface AdminEditPanelProps {
  submissionId: string;
  status: string;
  initial: {
    hackName: string;
    version: string;
    platform: string;
    author: string | null;
    releaseYear: number | null;
    releaseDate: string | null; // 'YYYY-MM-DD'
    description: string | null;
    versionChangelog: string | null;
    sourceUrl: string | null;
    translationLanguages?: string[];
  };
  mapping?: MappingValues | null;
  tags?: string[]; // current tag slugs
  currentFamily?: SelectedFamily | null;
  currentBaseRom?: SelectedBaseRom | null;
  hasOtherVersions?: boolean; // whether this hack has sibling versions to sync with
}

const inputClass = "w-full px-3 py-2 rounded-md bg-bg-base border border-border text-text-primary text-sm placeholder:text-text-muted focus:border-phosphor/50";

export function AdminEditPanel({ submissionId, status, initial, mapping, tags, currentFamily = null, currentBaseRom = null, hasOtherVersions }: AdminEditPanelProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    hackName: initial.hackName,
    version: initial.version,
    platform: initial.platform,
    author: initial.author ?? '',
    releaseYear: initial.releaseYear ? String(initial.releaseYear) : '',
    releaseDate: initial.releaseDate ?? '',
    description: initial.description ?? '',
    versionChangelog: initial.versionChangelog ?? '',
    sourceUrl: initial.sourceUrl ?? '',
  });
  // Starts in whichever mode matches what's already on record — a
  // year-only submission shouldn't silently switch to showing an empty
  // date picker just because this panel opened.
  const [releaseYearOnly, setReleaseYearOnly] = useState(!initial.releaseDate && !!initial.releaseYear);
  const [mappingForm, setMappingForm] = useState<MappingValues>(mapping ?? {});
  const [tagsForm, setTagsForm] = useState<string[]>(tags ?? []);
  const [translationLanguagesForm, setTranslationLanguagesForm] = useState<string[]>(initial.translationLanguages ?? []);
  const [selectedFamily, setSelectedFamily] = useState<SelectedFamily | null>(currentFamily);
  const [selectedBaseRom, setSelectedBaseRom] = useState<SelectedBaseRom | null>(currentBaseRom);
  const [applyToAllVersions, setApplyToAllVersions] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (field: keyof typeof form, value: string) => setForm((f) => ({ ...f, [field]: value }));

  // Order-insensitive — same helper ChangeRequestSection.tsx already has
  // for the identical tags/translationLanguages comparison below.
  const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

  // FIX (September 4 2026): this used to send the ENTIRE form on every
  // save, unconditionally — every field's current value, whether or not it
  // was actually touched. That's what produced "Version changelog:
  // Expected string, received null" the moment an admin edited ANY field
  // on a submission whose versionChangelog (or description/author/
  // sourceUrl) happened to already be null: the untouched, still-null field
  // got resent as literal `null` every time and tripped patchFieldLimits'
  // then-non-nullable check (now fixed on that end too — see the FIX note
  // on patchFieldLimits itself). Rebuilt to diff against `initial`/`tags`/
  // `currentBaseRom` and only send what actually changed, mirroring the
  // diffing ChangeRequestSection.tsx's submitRequest() already does for the
  // exact same fields — this is the direct fix for "edit a specific entry
  // without worrying about the others."
  //
  // Diffing here also closes two real, connected gaps found while fixing
  // this, not separately reported before now: (1) hasTagChanges/
  // hasMappingChanges on the PATCH route were EFFECTIVELY always true
  // for every save through this panel, since tags/every mapping key were
  // always present in the body regardless of whether they were touched —
  // meaning ANY edit (even just fixing a typo in the hack name) also
  // force-resynced this submission's tags onto every sibling version
  // (propagateTags does a blind full-replace, no change-detection of its
  // own), silently overwriting a sibling's legitimately-different tags —
  // exactly the kind of per-version difference the granular tag system was
  // built to support. (2) The same always-present pattern meant
  // hasMappingChanges was also always true, so every edit of an APPROVED
  // submission fired an immediate Hasheous push (see the trigger at the
  // bottom of the PATCH route) regardless of whether the Mappings section
  // was touched at all. Diffing makes both of these fire only when the
  // relevant thing genuinely changed, same as the audit log's own "fields"
  // list now accurately reflecting what was actually edited instead of
  // listing every field every time.
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const changes: Record<string, unknown> = {};
      if (form.hackName !== initial.hackName) changes.hackName = form.hackName;
      if (form.version !== initial.version) changes.version = form.version;
      if (form.platform !== initial.platform) changes.platform = form.platform;
      if (form.author !== (initial.author ?? '')) changes.author = form.author || null;
      if (form.description !== (initial.description ?? '')) changes.description = form.description || null;
      if (form.versionChangelog !== (initial.versionChangelog ?? '')) changes.versionChangelog = form.versionChangelog || null;
      if (form.sourceUrl !== (initial.sourceUrl ?? '')) changes.sourceUrl = form.sourceUrl || null;

      // Paired, same reasoning as ChangeRequestSection's identical check —
      // if either half differs from what's on record, send both together
      // so saving correctly clears whichever one is being switched away
      // from (see resolveReleaseFields() in src/lib/hackFamily.ts).
      const newYear = form.releaseYear ? parseInt(form.releaseYear, 10) : null;
      const newDate = form.releaseDate || null;
      if (newYear !== initial.releaseYear || newDate !== (initial.releaseDate ?? null)) {
        changes.releaseYear = newYear;
        changes.releaseDate = newDate;
      }

      const mappingPayload: Record<string, string | null> = {};
      for (const key of MAPPING_FIELD_KEYS) {
        const newVal = mappingForm[key] || null;
        const oldVal = mapping?.[key] || null;
        if (newVal !== oldVal) mappingPayload[key] = newVal;
      }

      const tagsChanged = !sameSet(tagsForm, tags ?? []);
      const translationLanguagesChanged = !sameSet(translationLanguagesForm, initial.translationLanguages ?? []);
      // Only sent when there's a real, completed new pick that differs
      // from what was there — never clears it. BaseRomPicker's own
      // "Change" button resets its value to null mid-pick without an
      // explicit "remove entirely" affordance the way FamilyPicker's
      // "Remove from family" is, and this app treats a base rom as
      // required at the application level — so silently sending a
      // null here (e.g. because the admin clicked Change and then
      // navigated away without finishing) would be an accidental,
      // hard-to-notice unlink. Assigning one for the first time to a
      // pre-existing submission that predates the requirement works
      // the same way this check already handles it: currentBaseRom is
      // null, any real pick differs from that, so it's sent.
      const baseRomChanged = !!selectedBaseRom && selectedBaseRom.id !== (currentBaseRom?.id ?? null);
      const familyChanged = (selectedFamily?.id ?? null) !== (currentFamily?.id ?? null);

      const hasMainPayload =
        Object.keys(changes).length > 0 || Object.keys(mappingPayload).length > 0 ||
        tagsChanged || translationLanguagesChanged || baseRomChanged;

      if (!hasMainPayload && !familyChanged) {
        // Nothing actually changed — closing the panel without a wasted
        // round trip (and a misleading, empty-fields audit log entry) is
        // the honest behavior here, same as Cancel.
        setOpen(false);
        return;
      }

      if (hasMainPayload) {
        const res = await fetch(`/api/submissions/${submissionId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...changes,
            ...(tagsChanged ? { tags: tagsForm } : {}),
            ...(translationLanguagesChanged ? { translationLanguages: translationLanguagesForm } : {}),
            applyToAllVersions,
            ...(baseRomChanged ? { baseRomId: selectedBaseRom!.id } : {}),
            ...mappingPayload,
          }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(describeValidationError(data.details) ?? data.error ?? 'Save failed');
          return;
        }
      }

      // Family reassignment is a separate endpoint (membership, not a
      // field-sync change — see reassignSubmissionFamily in
      // src/lib/hackFamily.ts), fired only if it actually changed, after
      // the main save succeeds (or is skipped entirely, if this save is
      // ONLY a family change). A failure here doesn't roll back the main
      // save above — that already committed successfully and there's no
      // reason to lose it over an unrelated follow-up call.
      if (familyChanged) {
        const familyRes = await fetch(`/api/admin/submissions/${submissionId}/family`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hackFamilyId: selectedFamily?.id ?? null }),
        });
        if (!familyRes.ok) {
          const data = await familyRes.json().catch(() => ({}));
          setError(hasMainPayload
            ? `Saved the other changes, but the family change failed: ${data.error ?? 'please try again'}`
            : `Family change failed: ${data.error ?? 'please try again'}`);
          return;
        }
      }

      setOpen(false);
      router.refresh();
    } catch {
      setError('Network error — please try again');
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-border text-text-secondary text-sm hover:border-phosphor/40 hover:text-phosphor transition-colors"
      >
        <Pencil size={14} /> Edit / rename
      </button>
    );
  }

  return (
    <div className="p-5 rounded-lg border border-border bg-bg-surface space-y-4">
      <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider">Edit submission</h2>

      {status === 'APPROVED' && (
        <div className="flex items-start gap-2 p-2.5 rounded-md bg-status-pending-bg border border-status-pending/30">
          <AlertTriangle size={13} className="text-status-pending shrink-0 mt-0.5" />
          <p className="text-xs text-status-pending">
            This is live in the DAT. Renaming the hack name/version/platform here also renames the exported entry.
          </p>
        </div>
      )}

      <div className="space-y-3">
        <div>
          <label className="block text-xs text-text-muted mb-1">Hack name</label>
          <input className={inputClass} value={form.hackName} onChange={(e) => update('hackName', e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-text-muted mb-1">Version</label>
            <input className={inputClass} value={form.version} onChange={(e) => update('version', e.target.value)} />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Platform</label>
            <select className={inputClass} value={form.platform} onChange={(e) => update('platform', e.target.value)}>
              {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>)}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-text-muted mb-1">Author</label>
            <input className={inputClass} value={form.author} onChange={(e) => update('author', e.target.value)} />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Release date</label>
            <div className="space-y-1.5">
              {!releaseYearOnly ? (
                <input
                  type="date"
                  className={inputClass}
                  value={form.releaseDate}
                  min="1990-01-01"
                  max={`${new Date().getFullYear() + 1}-12-31`}
                  onChange={(e) => update('releaseDate', e.target.value)}
                />
              ) : (
                <input
                  type="number"
                  className={inputClass}
                  value={form.releaseYear}
                  onChange={(e) => update('releaseYear', e.target.value)}
                />
              )}
              <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={releaseYearOnly}
                  onChange={(e) => {
                    const yearOnly = e.target.checked;
                    setReleaseYearOnly(yearOnly);
                    if (yearOnly) update('releaseDate', '');
                    else update('releaseYear', '');
                  }}
                  className="accent-phosphor"
                />
                Only the year is known
              </label>
            </div>
          </div>
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Description</label>
          <textarea rows={3} className={inputClass} value={form.description} onChange={(e) => update('description', e.target.value)} />
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Version changelog</label>
          <textarea rows={2} className={inputClass} value={form.versionChangelog} onChange={(e) => update('versionChangelog', e.target.value)} placeholder="What's different in this specific version" />
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Source URL</label>
          <input className={inputClass} value={form.sourceUrl} onChange={(e) => update('sourceUrl', e.target.value)} />
        </div>

        <div>
          <label className="block text-xs text-text-muted mb-1">Base ROM</label>
          <BaseRomPicker platform={form.platform} value={selectedBaseRom} onChange={setSelectedBaseRom} />
        </div>

        <div>
          <label className="block text-xs text-text-muted mb-1">Family</label>
          <FamilyPicker
            platform={form.platform}
            excludeFamilyId={currentFamily?.id}
            value={selectedFamily}
            onChange={setSelectedFamily}
          />
        </div>

        <TagsEditor value={tagsForm} onChange={setTagsForm} />

        {tagsForm.some((slug) => TRANSLATION_TRIGGER_SLUGS.includes(slug)) && (
          <LanguagePicker value={translationLanguagesForm} onChange={setTranslationLanguagesForm} />
        )}

        <MappingsSection values={mappingForm} onChange={setMappingForm} />
      </div>

      {hasOtherVersions && (
        <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={applyToAllVersions}
            onChange={(e) => setApplyToAllVersions(e.target.checked)}
            className="accent-phosphor"
          />
          Apply hack name/author/release date/description/tag changes to all versions of this hack
        </label>
      )}

      {error && <p className="text-xs text-status-rejected whitespace-pre-line">{error}</p>}

      <div className="flex gap-2">
        <Button size="sm" loading={saving} onClick={save}>Save changes</Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </div>
  );
}
