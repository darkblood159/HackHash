'use client';

// src/components/ChangeRequestSection.tsx
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from './ui/Button';
import { Avatar } from './ui/Avatar';
import { formatDistanceToNow } from 'date-fns';
import { Pencil, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { PLATFORMS, PLATFORM_LABELS } from '@/types';
import { MappingsSection, type MappingValues } from './MappingsSection';
import { MAPPING_FIELD_KEYS } from '@/lib/mappingFields';
import { FamilyPicker, type SelectedFamily } from './FamilyPicker';
import { TagsEditor } from './TagsEditor';
import { LanguagePicker } from './LanguagePicker';
import { TRANSLATION_TRIGGER_SLUGS } from '@/lib/tags';
import { languageName } from '@/lib/languages';
import { FIELD_LABELS, describeValidationError } from '@/lib/fieldLabels';

interface ChangeRequest {
  id: string;
  changes: Record<string, string | number | null>;
  reason: string | null;
  status: string;
  reviewNote: string | null;
  applyToAllVersions?: boolean;
  proposedTags?: string[] | null;
  proposedTranslationLanguages?: string[] | null;
  proposedFamily?: { id: string | null; name: string | null } | null;
  createdAt: string | Date;
  requestedBy: { id: string; name: string | null; image: string | null };
  reviewedBy?: { id: string; name: string | null } | null;
}

interface ChangeRequestSectionProps {
  submissionId: string;
  current: {
    hackName: string;
    version: string;
    versionChangelog: string | null;
    author: string | null;
    releaseYear: number | null;
    releaseDate: string | null; // 'YYYY-MM-DD'
    platform: string;
    sourceUrl: string | null;
  };
  currentMapping?: MappingValues | null;
  currentFamily?: SelectedFamily | null;
  currentTags?: string[]; // current tag slugs
  currentTranslationLanguages?: string[];
  initialRequests: ChangeRequest[];
  isAdmin: boolean;
  canRequest: boolean;
  hasOtherVersions?: boolean; // whether this hack has sibling versions to sync with
}

const inputClass = "w-full px-3 py-2 rounded-md bg-bg-base border border-border text-text-primary text-sm placeholder:text-text-muted focus:border-phosphor/50";

export function ChangeRequestSection({ submissionId, current, currentMapping, currentFamily = null, currentTags = [], currentTranslationLanguages = [], initialRequests, isAdmin, canRequest, hasOtherVersions }: ChangeRequestSectionProps) {
  const router = useRouter();
  const [requests, setRequests] = useState(initialRequests);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    hackName: current.hackName,
    version: current.version,
    versionChangelog: current.versionChangelog ?? '',
    author: current.author ?? '',
    releaseYear: current.releaseYear ? String(current.releaseYear) : '',
    releaseDate: current.releaseDate ?? '',
    platform: current.platform,
    sourceUrl: current.sourceUrl ?? '',
  });
  // Starts in whichever mode matches the submission's current data — see
  // the identical reasoning in AdminEditPanel.tsx.
  const [releaseYearOnly, setReleaseYearOnly] = useState(!current.releaseDate && !!current.releaseYear);
  const [mappingForm, setMappingForm] = useState<MappingValues>(currentMapping ?? {});
  const [selectedFamily, setSelectedFamily] = useState<SelectedFamily | null>(currentFamily);
  const [tagsForm, setTagsForm] = useState<string[]>(currentTags);
  const [translationLanguagesForm, setTranslationLanguagesForm] = useState<string[]>(currentTranslationLanguages);
  const [applyToAllVersions, setApplyToAllVersions] = useState(true);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);

  const update = (field: keyof typeof form, value: string) => setForm((f) => ({ ...f, [field]: value }));

  // Order-insensitive — tags/languages are sets from the user's point of
  // view, so re-picking the same ones in a different order shouldn't count
  // as a proposed change.
  const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

  const submitRequest = async () => {
    // Only include fields that actually differ from the current values
    const changes: Record<string, string | number | null> = {};
    if (form.hackName !== current.hackName) changes.hackName = form.hackName;
    if (form.version !== current.version) changes.version = form.version;
    if (form.versionChangelog !== (current.versionChangelog ?? '')) changes.versionChangelog = form.versionChangelog || null;
    if (form.author !== (current.author ?? '')) changes.author = form.author || null;
    // Proposed together, not independently diffed like every other field
    // above — if either differs from what's on record, both go in the
    // proposal, so approving it can correctly clear whichever one the
    // proposal is switching away from (see resolveReleaseFields() in
    // src/lib/hackFamily.ts, applied at approval time).
    const newYear = form.releaseYear ? parseInt(form.releaseYear, 10) : null;
    const newDate = form.releaseDate || null;
    if (newYear !== current.releaseYear || newDate !== (current.releaseDate ?? null)) {
      changes.releaseYear = newYear;
      changes.releaseDate = newDate;
    }
    if (form.platform !== current.platform) changes.platform = form.platform;
    if (form.sourceUrl !== (current.sourceUrl ?? '')) changes.sourceUrl = form.sourceUrl || null;

    for (const key of MAPPING_FIELD_KEYS) {
      const newVal = mappingForm[key] || null;
      const oldVal = currentMapping?.[key] || null;
      if (newVal !== oldVal) changes[key] = newVal;
    }

    const familyChanged = (selectedFamily?.id ?? null) !== (currentFamily?.id ?? null);
    const tagsChanged = !sameSet(tagsForm, currentTags);
    const translationLanguagesChanged = !sameSet(translationLanguagesForm, currentTranslationLanguages);

    if (Object.keys(changes).length === 0 && !familyChanged && !tagsChanged && !translationLanguagesChanged) {
      setError('No changes proposed — edit at least one field, change the tags, or pick a different family.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/submissions/${submissionId}/change-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes,
          reason: reason || undefined,
          applyToAllVersions,
          ...(familyChanged ? { proposedFamily: { id: selectedFamily?.id ?? null, name: selectedFamily?.name ?? null } } : {}),
          ...(tagsChanged ? { proposedTags: tagsForm } : {}),
          ...(translationLanguagesChanged ? { proposedTranslationLanguages: translationLanguagesForm } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(describeValidationError(data.details) ?? data.error ?? 'Failed to submit request');
        return;
      }
      setRequests((r) => [data, ...r]);
      setOpen(false);
      setReason('');
    } catch {
      setError('Network error — please try again');
    } finally {
      setSubmitting(false);
    }
  };

  const review = async (id: string, action: 'APPROVE' | 'REJECT') => {
    setReviewing(id);
    try {
      const res = await fetch(`/api/admin/change-requests/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        router.refresh();
        setRequests((r) => r.map((req) => (req.id === id ? { ...req, status: action === 'APPROVE' ? 'APPROVED' : 'REJECTED' } : req)));
      }
    } finally {
      setReviewing(null);
    }
  };

  return (
    <div className="p-5 rounded-lg border border-border bg-bg-surface">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-text-primary">Change requests ({requests.length})</h2>
        {canRequest && !open && (
          <button onClick={() => setOpen(true)} className="text-xs text-phosphor flex items-center gap-1 hover:underline">
            <Pencil size={12} /> Propose a change
          </button>
        )}
      </div>

      {open && (
        <div className="mb-5 p-4 rounded-lg bg-bg-base border border-border space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-muted mb-1">Hack name</label>
              <input className={inputClass} value={form.hackName} onChange={(e) => update('hackName', e.target.value)} />
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">Version</label>
              <input className={inputClass} value={form.version} onChange={(e) => update('version', e.target.value)} />
            </div>
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
            <div>
              <label className="block text-xs text-text-muted mb-1">Platform</label>
              <select className={inputClass} value={form.platform} onChange={(e) => update('platform', e.target.value)}>
                {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">Source URL</label>
              <input className={inputClass} value={form.sourceUrl} onChange={(e) => update('sourceUrl', e.target.value)} />
            </div>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Version changelog</label>
            <textarea rows={2} className={inputClass} placeholder="What's different in this specific version" value={form.versionChangelog} onChange={(e) => update('versionChangelog', e.target.value)} />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Why? (helps the admin reviewing this)</label>
            <textarea rows={2} className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>

          <MappingsSection values={mappingForm} onChange={setMappingForm} />

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

          {hasOtherVersions && (
            <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={applyToAllVersions}
                onChange={(e) => setApplyToAllVersions(e.target.checked)}
                className="accent-phosphor"
              />
              If approved, apply hack name/author/release date/description/tag changes to all versions of this hack
              {tagsForm.some((slug) => TRANSLATION_TRIGGER_SLUGS.includes(slug)) && (
                <span className="text-text-muted/70"> (language doesn't sync — it's specific to this version)</span>
              )}
            </label>
          )}
          {error && <p className="text-xs text-status-rejected whitespace-pre-line">{error}</p>}
          <div className="flex gap-2">
            <Button size="sm" loading={submitting} onClick={submitRequest}>Submit request</Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {requests.length === 0 && !open && <p className="text-sm text-text-muted">No change requests yet.</p>}

      <div className="space-y-3">
        {requests.map((r) => (
          <div key={r.id} className="flex items-start gap-3 p-3 rounded-lg bg-bg-base border border-border-subtle">
            <Avatar src={r.requestedBy.image} name={r.requestedBy.name} size={26} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-text-primary">{r.requestedBy.name}</span>
                <span className="text-xs text-text-muted">{formatDistanceToNow(new Date(r.createdAt), { addSuffix: true })}</span>
                {r.status === 'PENDING' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-pending-bg text-status-pending flex items-center gap-1"><Clock size={9} /> Pending</span>}
                {r.status === 'APPROVED' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-approved-bg text-status-approved flex items-center gap-1"><CheckCircle2 size={9} /> Applied</span>}
                {r.status === 'REJECTED' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-rejected-bg text-status-rejected flex items-center gap-1"><XCircle size={9} /> Rejected</span>}
              </div>
              <div className="mt-1.5 space-y-0.5">
                {Object.entries(r.changes).map(([field, value]) => (
                  <p key={field} className="text-xs text-text-secondary">
                    <span className="text-text-muted">{FIELD_LABELS[field] ?? field}:</span> {value === null || value === '' ? <em className="text-text-muted">cleared</em> : String(value)}
                  </p>
                ))}
                {r.proposedTags !== undefined && r.proposedTags !== null && (
                  <p className="text-xs text-text-secondary">
                    <span className="text-text-muted">Tags:</span>{' '}
                    {r.proposedTags.length ? r.proposedTags.join(', ') : <em className="text-text-muted">cleared</em>}
                  </p>
                )}
                {r.proposedTranslationLanguages !== undefined && r.proposedTranslationLanguages !== null && (
                  <p className="text-xs text-text-secondary">
                    <span className="text-text-muted">Translated into:</span>{' '}
                    {r.proposedTranslationLanguages.length
                      ? r.proposedTranslationLanguages.map(languageName).join(', ')
                      : <em className="text-text-muted">cleared</em>}
                  </p>
                )}
                {r.proposedFamily !== undefined && r.proposedFamily !== null && (
                  <p className="text-xs text-text-secondary">
                    <span className="text-text-muted">Family:</span>{' '}
                    {r.proposedFamily.id ? r.proposedFamily.name : <em className="text-text-muted">remove from family</em>}
                  </p>
                )}
              </div>
              {r.reason && <p className="text-xs text-text-muted mt-1.5 italic">"{r.reason}"</p>}
              {hasOtherVersions && r.applyToAllVersions !== false && r.status === 'PENDING' && (
                <p className="text-xs text-phosphor mt-1">Approving this will apply the shared-field changes to every version of this hack.</p>
              )}
              {r.proposedFamily !== undefined && r.proposedFamily !== null && r.status === 'PENDING' && (
                <p className="text-xs text-phosphor mt-1">Approving this will also move it to the proposed family, regardless of the setting above.</p>
              )}

              {isAdmin && r.status === 'PENDING' && (
                <div className="flex gap-2 mt-2">
                  <button
                    disabled={reviewing === r.id}
                    onClick={() => review(r.id, 'APPROVE')}
                    className="text-xs px-2 py-1 rounded border border-status-approved/40 text-status-approved hover:bg-status-approved-bg disabled:opacity-50"
                  >
                    Approve & apply
                  </button>
                  <button
                    disabled={reviewing === r.id}
                    onClick={() => review(r.id, 'REJECT')}
                    className="text-xs px-2 py-1 rounded border border-status-rejected/40 text-status-rejected hover:bg-status-rejected-bg disabled:opacity-50"
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
