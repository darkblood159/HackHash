'use client';

// src/components/SubmitForm.tsx
import React, { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useSession, signIn } from 'next-auth/react';
import { ROMProcessor } from './ROMProcessor';
import { MappingsSection, type MappingValues } from './MappingsSection';
import { HackNameAutocomplete, type HackFamilySuggestion } from './HackNameAutocomplete';
import { BaseRomPicker, type SelectedBaseRom } from './BaseRomPicker';
import { Button } from './ui/Button';
import { AlertTriangle, CheckCircle2, ChevronLeft, FileWarning, Loader2, Sparkles } from 'lucide-react';
import type { ROMFileInfo } from '@/types';
import { PLATFORMS, PLATFORM_LABELS } from '@/types';
import { TRANSLATION_TRIGGER_SLUGS } from '@/lib/tags';
import { describeValidationError } from '@/lib/fieldLabels';
import { TagsEditor } from './TagsEditor';
import { LanguagePicker } from './LanguagePicker';
import { parseRomFilename } from '@/lib/filenameParser';
import { MAPPING_FIELD_KEYS } from '@/lib/mappingFields';

const PATCH_TYPES = ['IPS', 'BPS', 'UPS', 'XDELTA', 'PPF', 'APS'] as const;

interface FormState {
  hackName: string;
  version: string;
  description: string;
  versionChangelog: string;
  author: string;
  releaseYear: string;
  releaseDate: string; // 'YYYY-MM-DD' from <input type="date">, mutually exclusive with releaseYear via the "I only know the year" toggle
  platform: string;
  sourceUrl: string;
  patchType: string;
  patchFilename: string;
  patchSha1: string;
  notes: string;
  releasePageUrl: string;
  githubUrl: string;
  tags: string[];
  translationLanguages: string[];
  // Game database mapping IDs
  igdbId: string;
  theGamesDBId: string;
  launchboxId: string;
  steamGridDBId: string;
  retroAchievementsId: string;
  steamId: string;
  gogId: string;
  giantBombId: string;
  screenScraperId: string;
  epicGamesId: string;
  wikipediaUrl: string;
}

const initialForm: FormState = {
  hackName: '', version: '', description: '', versionChangelog: '', author: '', releaseYear: '', releaseDate: '',
  platform: '', sourceUrl: '', patchType: '', patchFilename: '', patchSha1: '',
  notes: '', releasePageUrl: '', githubUrl: '', tags: [], translationLanguages: [],
  igdbId: '', theGamesDBId: '', launchboxId: '', steamGridDBId: '', retroAchievementsId: '',
  steamId: '', gogId: '', giantBombId: '', screenScraperId: '', epicGamesId: '', wikipediaUrl: '',
};

function Field({ label, required, hint, autoFilled, children }: { label: string; required?: boolean; hint?: string; autoFilled?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="flex items-center gap-1.5 text-sm font-medium text-text-primary mb-1.5">
        {label} {required && <span className="text-phosphor">*</span>}
        {autoFilled && (
          <span className="flex items-center gap-0.5 text-[10px] font-normal text-phosphor/80 normal-case tracking-normal">
            <Sparkles size={10} /> auto-filled
          </span>
        )}
      </label>
      {children}
      {hint && <p className="text-xs text-text-muted mt-1">{hint}</p>}
    </div>
  );
}

const inputClass = "w-full px-3 py-2 rounded-md bg-bg-surface border border-border text-text-primary text-sm placeholder:text-text-muted focus:border-phosphor/50 transition-colors";

export function SubmitForm() {
  const { data: session, status, update: updateSession } = useSession();
  const router = useRouter();

  const [romInfo, setRomInfo] = useState<ROMFileInfo | null>(null);
  const [form, setForm] = useState<FormState>(initialForm);
  const [baseRom, setBaseRom] = useState<SelectedBaseRom | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [earlyDuplicate, setEarlyDuplicate] = useState<{ id: string; hackName: string; version: string; status: string } | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<{ id: string; hackName: string } | null>(null);
  const [potentialDupes, setPotentialDupes] = useState<Array<{ id: string; hackName: string }>>([]);
  const [success, setSuccess] = useState<string | null>(null);
  const [changeRequestSubmitted, setChangeRequestSubmitted] = useState<string | null>(null);
  const [justPromoted, setJustPromoted] = useState(false);

  // Name-similarity check — tells the submitter if this hackName exactly
  // matches (or closely resembles) an existing hack on the same platform.
  // Checked on blur of the hackName field (and again if platform changes
  // afterward), same discrete-check style as check-duplicate above rather
  // than a live type-ahead.
  const [nameCheck, setNameCheck] = useState<{
    exactMatch: { id: string; name: string; author: string | null; releaseYear: number | null; releaseDate: string | null; description: string | null; tags?: string[] } | null;
    suggestions: Array<{ id: string; name: string; distance: number }>;
  } | null>(null);
  const [dismissedSuggestionFor, setDismissedSuggestionFor] = useState<string | null>(null);
  const [applyToAllVersions, setApplyToAllVersions] = useState(true);
  // Whether the release-date section is in "I only know the year" mode —
  // toggles between the <input type="date"> and the plain year fallback
  // right below it. Kept outside FormState (like applyToAllVersions above)
  // since it's a UI mode, not itself a submitted value — update() is
  // typed to string-only FormState fields, same reasoning that already
  // applies to applyToAllVersions.
  const [releaseYearOnly, setReleaseYearOnly] = useState(false);
  const nameSuggestionRef = useRef<HTMLDivElement>(null);
  const baseRomRef = useRef<HTMLDivElement>(null);
  // Fields populated by a family match (autocomplete pick, an exact
  // filename-parse match, or the blur/submit-time near-match resolving) —
  // tracked purely so those specific fields can get a brief visual marker,
  // distinguishing "the site filled this in for you, please check it" from
  // a field the submitter typed themselves. Cleared per-field the moment
  // it's edited.
  const [autoFilledFields, setAutoFilledFields] = useState<Set<string>>(new Set());

  const update = (field: keyof FormState, value: string) => {
    setForm((f) => ({ ...f, [field]: value }));
    setAutoFilledFields((prev) => {
      if (!prev.has(field)) return prev;
      const next = new Set(prev);
      next.delete(field);
      return next;
    });
  };


  // Full prefill for a known family — author/releaseYear/releaseDate/
  // description/tags (from the family itself) plus game database links (pulled from
  // whichever member submission actually has them; HackFamily itself
  // doesn't store these, see the route's own comment). Deliberately does
  // NOT touch version, patch details, source/release/GitHub URLs, or notes
  // — those are per-version by design, not something to copy from a
  // sibling. Only fills fields that are currently empty, same
  // never-clobber-what-was-typed rule as everywhere else in this flow.
  const applyFamilyPrefill = async (familyId: string) => {
    try {
      const res = await fetch(`/api/entries/hack-family/${familyId}`);
      if (!res.ok) return;
      const data = await res.json();
      const filled = new Set<string>();
      setForm((f) => {
        const next = { ...f };
        if (!f.platform && data.platform) { next.platform = data.platform; filled.add('platform'); }
        if (!f.author && data.author) { next.author = data.author; filled.add('author'); }
        if (!f.releaseDate && !f.releaseYear) {
          // Prefer the family's full date when it has one; fall back to
          // year-only. Either way this also sets the toggle so the right
          // input actually shows what just got filled in — silently
          // filling releaseYear while the date picker stays visible (or
          // vice versa) would look like the prefill did nothing.
          if (data.releaseDate) { next.releaseDate = data.releaseDate; filled.add('releaseDate'); setReleaseYearOnly(false); }
          else if (data.releaseYear) { next.releaseYear = String(data.releaseYear); filled.add('releaseYear'); setReleaseYearOnly(true); }
        }
        if (!f.description && data.description) { next.description = data.description; filled.add('description'); }
        if (!f.tags.length && data.tags?.length) { next.tags = data.tags; filled.add('tags'); }
        if (data.gameDatabaseLinks) {
          for (const [key, val] of Object.entries(data.gameDatabaseLinks)) {
            if (val && !f[key as keyof FormState]) {
              (next as Record<string, unknown>)[key] = val;
              filled.add(key);
            }
          }
        }
        return next;
      });
      if (filled.size > 0) setAutoFilledFields((prev) => new Set([...Array.from(prev), ...Array.from(filled)]));
    } catch {
      // Non-fatal — same convenience-not-gate philosophy as the rest of this.
    }
  };

  const checkSimilarName = async (name: string, platform: string) => {
    if (!name.trim() || !platform) {
      setNameCheck(null);
      return null;
    }
    try {
      const res = await fetch(`/api/submissions/check-similar-name?name=${encodeURIComponent(name)}&platform=${encodeURIComponent(platform)}`);
      const data = await res.json();
      setNameCheck(data);
      if (data.exactMatch) {
        await applyFamilyPrefill(data.exactMatch.id);
      }
      return data;
    } catch {
      // Non-fatal — a convenience check, not a hard gate; a network hiccup
      // here shouldn't block filling out the rest of the form.
      return null;
    }
  };

  // Autocomplete suggestion picked directly — already unambiguous (we have
  // the family id right there), no need to re-derive it via a name+platform
  // lookup the way checkSimilarName has to for the blur/submit-time path.
  const handleSuggestionSelect = (s: HackFamilySuggestion) => {
    update('hackName', s.name);
    if (!form.platform) update('platform', s.platform);
    checkSimilarName(s.name, s.platform);
  };

  const handleFileProcessed = async (info: ROMFileInfo) => {
    setRomInfo(info);
    setEarlyDuplicate(null);

    // Best-effort starting point from the filename — never authoritative,
    // always editable below. Only fills hackName/version if they're still
    // empty (always true on a first file pick, but this stays safe if a
    // second file is ever processed after the form's already been touched).
    const parsedName = parseRomFilename(info.filename);
    if (parsedName.hackName) {
      setForm((f) => ({
        ...f,
        hackName: f.hackName || parsedName.hackName,
        version: f.version || parsedName.version || '',
      }));
    }

    // Check for an exact-hash duplicate AND, if the filename parse found a
    // name, see whether it uniquely matches one existing hack (platform
    // isn't known yet at this point, so this searches across all of them —
    // only auto-applied if there's exactly one match, to avoid guessing
    // between two same-named hacks on different platforms).
    const [dupResult, matchResult] = await Promise.allSettled([
      fetch(`/api/submissions/check-duplicate?sha1=${info.sha1}`).then((r) => r.json()),
      parsedName.hackName
        ? fetch(`/api/entries/autocomplete?q=${encodeURIComponent(parsedName.hackName)}`).then((r) => r.json())
        : Promise.resolve(null),
    ]);

    if (dupResult.status === 'fulfilled' && dupResult.value?.duplicate) {
      setEarlyDuplicate(dupResult.value.duplicate);
    }
    if (matchResult.status === 'fulfilled' && matchResult.value) {
      const matches: HackFamilySuggestion[] = matchResult.value.suggestions ?? [];
      if (matches.length === 1) {
        handleSuggestionSelect(matches[0]);
      }
    }

    setStep(2);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!romInfo) return;

    if (!baseRom) {
      setError('A base ROM is required — select an approved one or hash your own copy above.');
      baseRomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    // The blur/platform-change checks above are convenience/early-warning —
    // this is the guaranteed one. Re-runs the check fresh regardless of
    // whether an earlier one already ran (cheap, and avoids any doubt about
    // stale state), and stops here if there's an unresolved "did you mean"
    // suggestion the submitter hasn't dismissed for this exact name. An
    // exact match doesn't stop anything — it's already shown + prefilled
    // above and needs no further decision to proceed.
    if (dismissedSuggestionFor !== form.hackName) {
      const freshCheck = await checkSimilarName(form.hackName, form.platform);
      if (freshCheck && !freshCheck.exactMatch && freshCheck.suggestions?.length > 0) {
        nameSuggestionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    }

    // Exact same file already exists in the database — instead of trying
    // (and failing, server-side) to create a disconnected duplicate
    // submission, package everything entered in this form as a proposed
    // update to the EXISTING one, for an admin to review. Only fields that
    // actually have a value get proposed — an admin reviewing this should
    // see "here's what's being suggested," not a wall of empty-string
    // "changes" for everything the submitter left blank.
    if (earlyDuplicate) {
      setSubmitting(true);
      setError(null);

      const changes: Record<string, string | number> = {};
      const maybeSet = (key: string, value: string, isNumber = false) => {
        if (value) changes[key] = isNumber ? parseInt(value, 10) : value;
      };
      maybeSet('hackName', form.hackName);
      maybeSet('version', form.version);
      maybeSet('versionChangelog', form.versionChangelog);
      maybeSet('author', form.author);
      maybeSet('releaseDate', form.releaseDate);
      maybeSet('releaseYear', form.releaseYear, true);
      maybeSet('description', form.description);
      maybeSet('sourceUrl', form.sourceUrl);
      maybeSet('platform', form.platform);
      maybeSet('notes', form.notes);
      maybeSet('releasePageUrl', form.releasePageUrl);
      maybeSet('githubUrl', form.githubUrl);
      maybeSet('patchType', form.patchType);
      maybeSet('patchFilename', form.patchFilename);
      maybeSet('patchSha1', form.patchSha1);
      for (const key of MAPPING_FIELD_KEYS) {
        maybeSet(key, form[key as keyof FormState] as string);
      }

      try {
        const res = await fetch(`/api/submissions/${earlyDuplicate.id}/change-request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            changes,
            proposedTags: form.tags.length > 0 ? form.tags : undefined,
            proposedTranslationLanguages: form.translationLanguages.length > 0 ? form.translationLanguages : undefined,
            // Same "only if it actually has a value" idea as every field
            // above (maybeSet), not the diff-against-current idea
            // ChangeRequestSection/AdminEditPanel use elsewhere — there's
            // no "current" to diff against in this flow's sense; this is
            // "everything the submitter picked in this form," proposed
            // wholesale, whether or not it happens to already match
            // earlyDuplicate's existing base rom.
            ...(baseRom ? { proposedBaseRom: { id: baseRom.id, name: baseRom.name } } : {}),
            applyToAllVersions,
            reason: 'Submitted while trying to upload a file that matched an existing entry\'s hash — proposed information for the existing entry instead of a new submission.',
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(describeValidationError(data.details) ?? data.error ?? 'Failed to submit updated information');
          setSubmitting(false);
          return;
        }
        setChangeRequestSubmitted(earlyDuplicate.id);
      } catch {
        setError('Network error — please try again');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    setSubmitting(true);
    setError(null);
    setDuplicateWarning(null);

    try {
      const res = await fetch('/api/submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hackName: form.hackName,
          version: form.version,
          author: form.author || undefined,
          releaseYear: form.releaseYear ? parseInt(form.releaseYear, 10) : undefined,
          releaseDate: form.releaseDate || undefined,
          platform: form.platform,
          sourceUrl: form.sourceUrl,
          filename: romInfo.filename,
          fileSize: romInfo.fileSize,
          crc32: romInfo.crc32,
          md5: romInfo.md5,
          sha1: romInfo.sha1,
          description: form.description || undefined,
          versionChangelog: form.versionChangelog || undefined,
          patchType: form.patchType || undefined,
          patchFilename: form.patchFilename || undefined,
          patchSha1: form.patchSha1 || undefined,
          baseRomId: baseRom!.id,
          notes: form.notes || undefined,
          releasePageUrl: form.releasePageUrl || undefined,
          githubUrl: form.githubUrl || undefined,
          tags: form.tags,
          translationLanguages: form.translationLanguages,
          // Game database mappings
          igdbId: form.igdbId || undefined,
          theGamesDBId: form.theGamesDBId || undefined,
          launchboxId: form.launchboxId || undefined,
          steamGridDBId: form.steamGridDBId || undefined,
          retroAchievementsId: form.retroAchievementsId || undefined,
          steamId: form.steamId || undefined,
          gogId: form.gogId || undefined,
          giantBombId: form.giantBombId || undefined,
          screenScraperId: form.screenScraperId || undefined,
          epicGamesId: form.epicGamesId || undefined,
          wikipediaUrl: form.wikipediaUrl || undefined,
          applyToAllVersions,
        }),
      });

      const data = await res.json();

      if (res.status === 409) {
        setDuplicateWarning(data.duplicate);
        setSubmitting(false);
        return;
      }

      if (!res.ok) {
        setError(describeValidationError(data.details) ?? data.error ?? 'Submission failed');
        setSubmitting(false);
        return;
      }

      if (data.potentialDuplicates?.length) {
        setPotentialDupes(data.potentialDuplicates);
      }

      if (data.promotedToContributor) {
        await updateSession();
        setJustPromoted(true);
      }

      setSuccess(data.submission.id);
    } catch {
      setError('Network error — please try again');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Banned gate ──
  if (status === 'authenticated' && session?.user.isBanned) {
    return (
      <div className="text-center py-16 border border-status-rejected/30 bg-status-rejected-bg rounded-xl">
        <p className="text-status-rejected font-medium mb-1">Your account has been banned.</p>
        <p className="text-text-secondary text-sm">You can't submit new hacks. If you think this is a mistake, contact an administrator.</p>
      </div>
    );
  }

  // ── Sign-in gate ──
  if (status === 'unauthenticated') {
    return (
      <div className="text-center py-16 border border-dashed border-border rounded-xl">
        <p className="text-text-secondary mb-4">Sign in to submit a ROM hack for review.</p>
        <Button onClick={() => signIn('github')}>Sign in with GitHub</Button>
      </div>
    );
  }

  // ── Success state ──
  if (changeRequestSubmitted) {
    return (
      <div className="text-center py-16 border border-phosphor/30 bg-phosphor/5 rounded-xl">
        <CheckCircle2 size={40} className="text-phosphor mx-auto mb-4" />
        <h2 className="font-display text-xl font-bold mb-2">Updated information submitted</h2>
        <p className="text-text-secondary mb-6 max-w-md mx-auto">
          Since this exact file is already in the database, what you entered was submitted as a proposed update to the
          existing entry instead of a new one — an admin will review it.
        </p>
        <div className="flex gap-3 justify-center">
          <Button variant="secondary" onClick={() => router.push(`/submissions/${changeRequestSubmitted}`)}>View entry</Button>
          <Button
            variant="ghost"
            onClick={() => {
              setChangeRequestSubmitted(null);
              setEarlyDuplicate(null);
              setRomInfo(null);
              setForm(initialForm);
              setStep(1);
            }}
          >
            Submit another
          </Button>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="text-center py-16 border border-phosphor/30 bg-phosphor/5 rounded-xl">
        <CheckCircle2 size={40} className="text-phosphor mx-auto mb-4" />
        <h2 className="font-display text-xl font-bold mb-2">Submission received</h2>
        <p className="text-text-secondary mb-6 max-w-md mx-auto">
          Your hashes are now visible to the community. Once others verify your hashes match their copy, it moves toward approval.
        </p>
        {justPromoted && (
          <div className="max-w-md mx-auto mb-6 p-3 rounded-lg bg-phosphor/10 border border-phosphor/30 text-sm text-phosphor">
            Welcome aboard — you've been promoted from Guest to Contributor.
          </div>
        )}
        {potentialDupes.length > 0 && (
          <div className="max-w-md mx-auto mb-6 p-3 rounded-lg bg-status-pending-bg border border-status-pending/30 text-left">
            <p className="text-xs font-medium text-status-pending flex items-center gap-1.5 mb-1">
              <FileWarning size={13} /> Possible related entries found
            </p>
            <p className="text-xs text-text-secondary">
              {potentialDupes.length} existing submission(s) share a partial hash match. Verifiers will review this.
            </p>
          </div>
        )}
        <div className="flex gap-3 justify-center">
          <Button variant="secondary" onClick={() => router.push(`/submissions/${success}`)}>View submission</Button>
          <Button variant="ghost" onClick={() => { setSuccess(null); setJustPromoted(false); setRomInfo(null); setForm(initialForm); setStep(1); }}>
            Submit another
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-8 text-sm">
        <span className={step === 1 ? 'text-phosphor font-medium' : 'text-text-muted'}>1. Hash ROM</span>
        <div className="flex-1 h-px bg-border" />
        <span className={step === 2 ? 'text-phosphor font-medium' : 'text-text-muted'}>2. Add details</span>
      </div>

      {step === 1 && (
        <ROMProcessor onFileProcessed={handleFileProcessed} showUseButton />
      )}

      {step === 2 && romInfo && (
        <form onSubmit={handleSubmit} className="space-y-8">
          {/* Confirmed hash summary */}
          <div className="p-4 rounded-lg bg-bg-surface border border-border">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-text-primary">{romInfo.filename}</span>
              <button type="button" onClick={() => { setStep(1); setEarlyDuplicate(null); }} className="text-xs text-text-muted hover:text-phosphor flex items-center gap-1">
                <ChevronLeft size={12} /> Re-hash
              </button>
            </div>
            <div className="grid sm:grid-cols-3 gap-2 font-mono text-xs text-text-secondary">
              <div>CRC <span className="text-phosphor">{romInfo.crc32}</span></div>
              <div className="truncate">MD5 <span className="text-phosphor">{romInfo.md5}</span></div>
              <div className="truncate">SHA1 <span className="text-phosphor">{romInfo.sha1}</span></div>
            </div>
          </div>

          {/* Early duplicate warning — shown immediately after hashing, before the
              user spends time filling in the form. Uses a high-contrast banner so
              it's impossible to miss. The server-side check on final submit is still
              the authoritative guard; this is just a helpful early heads-up. */}
          {earlyDuplicate && (
            <div className="p-4 rounded-lg border-2 border-status-rejected bg-status-rejected-bg">
              <div className="flex items-start gap-3">
                <AlertTriangle size={20} className="text-status-rejected shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-status-rejected font-semibold text-base">
                    This ROM is already in the database
                  </p>
                  <p className="text-text-secondary text-sm mt-1">
                    <strong className="text-text-primary">{earlyDuplicate.hackName}</strong> (v{earlyDuplicate.version})
                    {' '}is already submitted with this exact SHA-1 hash and is currently{' '}
                    <strong className="text-text-primary">{earlyDuplicate.status.toLowerCase().replace('_', ' ')}</strong>.
                  </p>
                  <a
                    href={`/submissions/${earlyDuplicate.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 rounded-md bg-status-rejected/20 text-status-rejected text-sm font-medium hover:bg-status-rejected/30 transition-colors"
                  >
                    View existing submission →
                  </a>
                  <p className="text-text-muted text-xs mt-3">
                    You can still fill out the form below, but instead of creating a separate entry, it'll be sent in as
                    proposed updated information for the existing one above, for an admin to review.
                  </p>
                </div>
              </div>
            </div>
          )}

          {duplicateWarning && (
            <div className="p-4 rounded-lg bg-status-rejected-bg border border-status-rejected/30 flex items-start gap-3">
              <AlertTriangle size={16} className="text-status-rejected shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="text-status-rejected font-medium">This exact ROM is already in the database</p>
                <p className="text-text-secondary mt-1">
                  Matches existing submission "{duplicateWarning.hackName}".{' '}
                  <a href={`/submissions/${duplicateWarning.id}`} className="text-phosphor hover:underline" target="_blank" rel="noreferrer">
                    View that submission instead
                  </a>{' '}
                  or verify that entry if you have the same ROM.
                </p>
              </div>
            </div>
          )}

          {/* Game database mappings — near the top so submitters see it early, but
              collapsible so it doesn't intimidate or clutter the required fields */}
          <MappingsSection
            values={{
              igdbId: form.igdbId, theGamesDBId: form.theGamesDBId, launchboxId: form.launchboxId,
              steamGridDBId: form.steamGridDBId, retroAchievementsId: form.retroAchievementsId,
              steamId: form.steamId, gogId: form.gogId, giantBombId: form.giantBombId,
              screenScraperId: form.screenScraperId, epicGamesId: form.epicGamesId, wikipediaUrl: form.wikipediaUrl,
            }}
            onChange={(m) => {
              Object.entries(m).forEach(([k, v]) => update(k as keyof typeof form, v ?? ''));
            }}
          />

          <div className="grid sm:grid-cols-2 gap-5">
            <Field label="Hack name" required>
              <HackNameAutocomplete
                value={form.hackName}
                onChange={(v) => { update('hackName', v); setNameCheck(null); }}
                onSelect={handleSuggestionSelect}
                onBlur={(v) => checkSimilarName(v, form.platform)}
                platform={form.platform || undefined}
                placeholder="24 Hour Hack"
                className={inputClass}
              />
            </Field>
            <Field label="Version" required>
              <div className="space-y-1.5">
                <input
                  required
                  disabled={form.version === 'Unknown'}
                  className={`${inputClass} disabled:opacity-50`}
                  value={form.version}
                  onChange={(e) => update('version', e.target.value)}
                  placeholder="1.0.1"
                />
                <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.version === 'Unknown'}
                    onChange={(e) => update('version', e.target.checked ? 'Unknown' : '')}
                    className="accent-phosphor"
                  />
                  Version isn't marked on this hack
                </label>
              </div>
            </Field>
            <Field label="Author" hint="Leave blank if unknown" autoFilled={autoFilledFields.has('author')}>
              <input className={inputClass} value={form.author} onChange={(e) => update('author', e.target.value)} placeholder="RomHacker99" />
            </Field>
            <Field label="Release date" hint="Leave blank if unknown" autoFilled={autoFilledFields.has('releaseYear') || autoFilledFields.has('releaseDate')}>
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
                    inputMode="numeric"
                    min={1990}
                    max={new Date().getFullYear() + 1}
                    className={inputClass}
                    value={form.releaseYear}
                    placeholder="e.g. 2023"
                    onKeyDown={(e) => {
                      // Block anything that isn't a digit, arrow key, backspace, tab, delete, or Enter
                      if (!/[\d]/.test(e.key) && !['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Backspace','Delete','Tab','Enter'].includes(e.key)) {
                        e.preventDefault();
                      }
                    }}
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^\d]/g, '');
                      update('releaseYear', v);
                    }}
                  />
                )}
                <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={releaseYearOnly}
                    onChange={(e) => {
                      const yearOnly = e.target.checked;
                      setReleaseYearOnly(yearOnly);
                      // Clear whichever field the toggle is switching AWAY
                      // from, so a value typed before flipping the toggle
                      // can't silently ride along to submit alongside the
                      // one actually shown.
                      if (yearOnly) update('releaseDate', '');
                      else update('releaseYear', '');
                    }}
                    className="accent-phosphor"
                  />
                  I only know the year
                </label>
              </div>
            </Field>
            <Field label="Platform" required hint="Which console/system is this for?" autoFilled={autoFilledFields.has('platform')}>
              <select
                required
                className={inputClass}
                value={form.platform}
                onChange={(e) => {
                  update('platform', e.target.value);
                  if (form.hackName.trim()) checkSimilarName(form.hackName, e.target.value);
                }}
              >
                <option value="" disabled>Select a platform…</option>
                {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>)}
              </select>
            </Field>
          </div>

          {/* Fuzzy name match — only while there's no exact match yet, and the
              submitter hasn't already said this one's a different hack */}
          {!nameCheck?.exactMatch && nameCheck?.suggestions && nameCheck.suggestions.length > 0 && dismissedSuggestionFor !== form.hackName && (
            <div ref={nameSuggestionRef} className="p-3 rounded-lg bg-status-pending-bg border border-status-pending/30">
              <p className="text-sm text-text-primary">
                Did you mean <strong>{nameCheck.suggestions[0].name}</strong>? A hack with a similar name already exists on this platform.
              </p>
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => {
                    const matchName = nameCheck.suggestions[0].name;
                    update('hackName', matchName);
                    checkSimilarName(matchName, form.platform);
                  }}
                  className="px-2.5 py-1 rounded-md text-xs font-medium bg-status-pending/20 text-status-pending hover:bg-status-pending/30 transition-colors"
                >
                  Use this name
                </button>
                <button
                  type="button"
                  onClick={() => setDismissedSuggestionFor(form.hackName)}
                  className="px-2.5 py-1 rounded-md text-xs font-medium border border-border text-text-muted hover:border-phosphor/30 transition-colors"
                >
                  No, this is different
                </button>
              </div>
            </div>
          )}

          {/* Exact match — this submission will join that hack's existing
              version family. Shared fields + game database links were
              already prefilled above via applyFamilyPrefill; fields that
              got auto-filled carry a small marker (Sparkles icon) so it's
              clear which ones to double-check, not just re-typed blind. */}
          {nameCheck?.exactMatch && (
            <div className="p-3 rounded-lg bg-phosphor/5 border border-phosphor/20">
              <p className="text-sm text-text-primary flex items-start gap-1.5">
                <Sparkles size={14} className="text-phosphor shrink-0 mt-0.5" />
                <span>
                  This will be added as a new version of <strong>{nameCheck.exactMatch.name}</strong>. Author, release date,
                  description, tags, and any game database links were pre-filled from the existing entry — take a second to
                  check they're still right for this version, and change anything that isn't.
                </span>
              </p>
              <label className="flex items-center gap-1.5 text-xs text-text-muted mt-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={applyToAllVersions}
                  onChange={(e) => setApplyToAllVersions(e.target.checked)}
                  className="accent-phosphor"
                />
                Keep author/release date/description/tags in sync across all versions of this hack
              </label>
            </div>
          )}

          {/* Base ROM (required) — moved up near the top, right after platform
              (which it depends on) and the name-match banners, instead of being
              buried below Patch Details. Required fields shouldn't be easy to miss. */}
          <div ref={baseRomRef} className="p-4 rounded-lg border border-border bg-bg-surface">
            <Field label="Base ROM" required hint="Which unpatched ROM this patch expects — the wrong one usually means a broken result. Pick an approved one, or hash your own copy if it's not listed yet.">
              <BaseRomPicker platform={form.platform} value={baseRom} onChange={setBaseRom} />
            </Field>
          </div>

          <Field label="Description" hint="What does this hack change? Optional, but helps verifiers and future archivists." autoFilled={autoFilledFields.has('description')}>
            <textarea rows={4} className={inputClass} value={form.description} onChange={(e) => update('description', e.target.value)} placeholder="A complete overhaul of the original level design with..." />
          </Field>

          <Field label="Version changelog" hint="What's new or different in THIS version compared to earlier ones? Helps people decide whether to update. Leave blank if this is the first version.">
            <textarea rows={3} className={inputClass} value={form.versionChangelog} onChange={(e) => update('versionChangelog', e.target.value)} placeholder="Fixed the softlock in World 3, rebalanced the final boss, added a new title screen." />
          </Field>

          <Field label="Source URL" required hint="Where can others find/download this hack to verify it?">
            <input required type="url" className={inputClass} value={form.sourceUrl} onChange={(e) => update('sourceUrl', e.target.value)} placeholder="https://www.romhacking.net/hacks/..." />
          </Field>

          {/* Tags */}
          <TagsEditor
            value={form.tags}
            autoFilled={autoFilledFields.has('tags')}
            onChange={(tags) => {
              setForm((f) => ({ ...f, tags }));
              setAutoFilledFields((prev) => {
                if (!prev.has('tags')) return prev;
                const next = new Set(prev);
                next.delete('tags');
                return next;
              });
            }}
          />

          {/* Only relevant once a translation-family tag is selected — see
              TRANSLATION_TRIGGER_SLUGS in src/lib/tags.ts. */}
          {form.tags.some((slug) => TRANSLATION_TRIGGER_SLUGS.includes(slug)) && (
            <LanguagePicker
              value={form.translationLanguages}
              onChange={(translationLanguages) => setForm((f) => ({ ...f, translationLanguages }))}
            />
          )}

          {/* Patch info (optional) */}
          <details className="group border border-border rounded-lg">
            <summary className="px-4 py-3 cursor-pointer text-sm font-medium text-text-primary list-none flex items-center justify-between">
              Patch details (optional)
              <span className="text-text-muted text-xs group-open:rotate-180 transition-transform">▾</span>
            </summary>
            <div className="px-4 pb-4 grid sm:grid-cols-2 gap-5">
              <Field label="Patch type">
                <select className={inputClass} value={form.patchType} onChange={(e) => update('patchType', e.target.value)}>
                  <option value="">None</option>
                  {PATCH_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>
              <Field label="Patch filename">
                <input className={inputClass} value={form.patchFilename} onChange={(e) => update('patchFilename', e.target.value)} placeholder="hack.bps" />
              </Field>
              <Field label="Patch SHA-1" hint="If you've hashed the patch file separately">
                <input className={`${inputClass} font-mono`} value={form.patchSha1} onChange={(e) => update('patchSha1', e.target.value)} placeholder="40-character hex" />
              </Field>
            </div>
          </details>

          {/* Links + notes (optional) */}
          <details className="group border border-border rounded-lg">
            <summary className="px-4 py-3 cursor-pointer text-sm font-medium text-text-primary list-none flex items-center justify-between">
              Additional links & notes (optional)
              <span className="text-text-muted text-xs group-open:rotate-180 transition-transform">▾</span>
            </summary>
            <div className="px-4 pb-4 space-y-5">
              <div className="grid sm:grid-cols-2 gap-5">
                <Field label="Release page URL">
                  <input type="url" className={inputClass} value={form.releasePageUrl} onChange={(e) => update('releasePageUrl', e.target.value)} placeholder="https://..." />
                </Field>
                <Field label="GitHub URL">
                  <input type="url" className={inputClass} value={form.githubUrl} onChange={(e) => update('githubUrl', e.target.value)} placeholder="https://github.com/..." />
                </Field>
              </div>
              <Field label="Notes">
                <textarea rows={3} className={inputClass} value={form.notes} onChange={(e) => update('notes', e.target.value)} placeholder="Anything verifiers should know" />
              </Field>
            </div>
          </details>

          {error && (
            <div className="p-3 rounded-lg bg-status-rejected-bg border border-status-rejected/30 text-sm text-status-rejected whitespace-pre-line">
              {error}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <Button type="submit" loading={submitting} disabled={!!duplicateWarning}>
              {earlyDuplicate ? 'Submit updated information' : 'Submit for review'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => { setStep(1); setEarlyDuplicate(null); }}>Back</Button>
          </div>
        </form>
      )}
    </div>
  );
}
