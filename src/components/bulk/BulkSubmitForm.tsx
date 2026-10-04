'use client';

// src/components/bulk/BulkSubmitForm.tsx
//
// Submit several versions of one hack — and their patches — in one sitting.
// Everything the single form does for ONE ROM, this does for a table of them,
// without relaxing any of it:
//   - every ROM is still hashed here, in the browser, and never uploaded;
//   - every version is still an ordinary PENDING submission that the
//     community verifies — a batch grants no shortcut to approval;
//   - the server re-checks every row itself (createSubmissionCore), so the
//     pre-check and the warnings below are a convenience, not the guard.
//
// It also recognises a hack that is ALREADY on HackHash, exactly like the
// single form: the name field suggests existing hacks, checks the name when
// you leave it, and on an exact match fills in the shared details that are
// still empty ("auto-filled", never overwriting anything entered — rules in
// src/lib/bulkFamilyPrefill.ts); a near match asks "did you mean…?" and
// sending is stopped until that is answered. The dry-run check (duplicate
// files, existing version labels) runs as soon as there is a name, a platform
// and a hashed file — it does not wait for a base ROM.
//
// Layout of this file: the shared "about the hack" details are entered once;
// ROMs dropped in become rows; patches dropped in are paired to rows (only
// when unambiguous — see bulkPairing.ts) and, when the base ROM is on hand,
// PROVEN against them by applying them in the browser (bulkVerify.ts);
// problems are computed in bulkRowState.ts. Sending creates one batch, then
// submits rows oldest version first (creation order is what orders a hack's
// version chips), one request at a time, then uploads patches one at a time.
// Nothing sent can be half-undone by a failure: whatever was created stays,
// and Retry only does what's left.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { AlertTriangle, CheckCircle2, Info, Loader2, Sparkles, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { BaseRomPicker, type SelectedBaseRom } from '../BaseRomPicker';
import { HackNameAutocomplete, type HackFamilySuggestion } from '../HackNameAutocomplete';
import { FranchisePicker, type SelectedFranchise } from '../FranchisePicker';
import { AuthorPicker, type SelectedAuthor } from '../AuthorPicker';
import { MappingsSection, type MappingValues } from '../MappingsSection';
import { TagsEditor } from '../TagsEditor';
import { LanguagePicker } from '../LanguagePicker';
import { PLATFORMS, PLATFORM_LABELS } from '@/types';
import { TRANSLATION_TRIGGER_SLUGS } from '@/lib/tags';
import { describeValidationError } from '@/lib/fieldLabels';
import { computeAllHashes } from '@/lib/romHash';
import { sha1Hex, patchTypeFromFilename, patchTypeLabel } from '@/lib/patchTypes';
import { expandDropped } from '@/lib/bulkIntake';
import { pairPatches, dateOrderIssues, versionFromFilename, hackNameFromFilename } from '@/lib/bulkPairing';
import { verifyPatchProducesRom } from '@/lib/bulkVerify';
import { planFamilyPrefill } from '@/lib/bulkFamilyPrefill';
import { getCachedRom } from '@/lib/romCache';
import {
  computeRowIssues,
  needsAck,
  warningSignature,
  sortRows,
  buildCreatePayload,
  type BulkRow,
  type BulkHeader,
  type PatchEntry,
} from '@/lib/bulkRowState';
import type { BulkPrecheckResult } from '@/lib/bulkChecks';
import { BulkRowCard } from './BulkRowCard';
import { BulkDropZone, Field, inputClass } from './ui';

interface LimitsInfo {
  enabled: boolean;
  disabledMessage: string | null;
  maxRows: number;
  maxBatchesPerDay: number;
  batchesUsedToday: number;
}

/** GET /api/submissions/check-similar-name — the same lookup the single form's name field uses. */
interface NameCheck {
  exactMatch: { id: string; name: string } | null;
  suggestions: Array<{ id: string; name: string; distance: number }>;
}

export function BulkSubmitForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Same query parameter name the single form uses for "Add new version".
  const fromSubmissionId = searchParams.get('fromSubmission');
  const { status, update: updateSession } = useSession();

  // ── what this account may do (GET /api/submissions/batches) ──
  const [limits, setLimits] = useState<LimitsInfo | null>(null);

  // ── shared "about the hack" details ──
  const [hackName, setHackName] = useState('');
  const [platform, setPlatform] = useState('');
  const [description, setDescription] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [releasePageUrl, setReleasePageUrl] = useState('');
  const [githubUrl, setGithubUrl] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [translationLanguages, setTranslationLanguages] = useState<string[]>([]);
  const [mappings, setMappings] = useState<MappingValues>({});
  const [baseRom, setBaseRom] = useState<SelectedBaseRom | null>(null);
  const [author, setAuthor] = useState<SelectedAuthor | null>(null);
  const [legacyAuthor, setLegacyAuthor] = useState<string | null>(null);
  const [franchise, setFranchise] = useState<SelectedFranchise | null>(null);
  const [prefillNote, setPrefillNote] = useState<string | null>(null);

  // ── matching an EXISTING hack (same behaviour as the single form) ──
  // The name is checked against the hack list when the field loses focus, when
  // the platform changes, when a suggestion is picked, and when a name is
  // guessed from the dropped files. An exact match fills in whatever shared
  // details are still empty (see applyFamilyPrefill); a near match asks
  // "did you mean…?".
  const [nameCheck, setNameCheck] = useState<NameCheck | null>(null);
  const [dismissedSuggestionFor, setDismissedSuggestionFor] = useState<string | null>(null);
  // Which header fields were filled in by the site (not typed or picked), for
  // the small "auto-filled" marker. A field drops out the moment it's edited.
  const [autoFilled, setAutoFilled] = useState<Set<string>>(new Set());

  // ── the table ──
  const [rows, setRows] = useState<BulkRow[]>([]);
  const [patches, setPatches] = useState<PatchEntry[]>([]);
  const [sortMode, setSortMode] = useState<'version' | 'date'>('version');
  const [notes, setNotes] = useState<string[]>([]);
  const [intakeBusy, setIntakeBusy] = useState(false);
  const [hashKick, setHashKick] = useState(0);
  const [verifyTick, setVerifyTick] = useState(0);

  // ── dry-run check against the database ──
  const [precheck, setPrecheck] = useState<BulkPrecheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState<string | null>(null);

  // ── base ROM, only for proving patches ──
  const [baseFile, setBaseFile] = useState<{ name: string; sha1: string; bytes: Uint8Array } | null>(null);
  const [cachedBase, setCachedBase] = useState<Uint8Array | null>(null);
  const [baseBusy, setBaseBusy] = useState(false);

  // ── sending ──
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Refs mirror state for the long-running async loops (hashing, verifying,
  // sending), which must read the CURRENT table, not the one captured when
  // they started.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const patchesRef = useRef(patches);
  patchesRef.current = patches;
  const sortModeRef = useRef(sortMode);
  sortModeRef.current = sortMode;
  const hashQueueRef = useRef<string[]>([]);
  const hashingRef = useRef(false);
  const verifyingRef = useRef(false);
  const checkSeqRef = useRef(0);
  const keySeqRef = useRef(0);
  const batchIdRef = useRef<string | null>(null);
  const nextKey = (prefix: string) => `${prefix}${++keySeqRef.current}`;

  // Current values of the shared details, for the async name-match code below
  // (it resolves after a network round trip, so it must read what the header
  // holds NOW, not what it held when the request started — the same reason
  // the single form keeps franchiseRef/authorRef). Refreshed on every render;
  // the apply* helpers also write them straight away.
  const hackNameRef = useRef(hackName);
  hackNameRef.current = hackName;
  const platformRef = useRef(platform);
  platformRef.current = platform;
  const descriptionRef = useRef(description);
  descriptionRef.current = description;
  const tagsRef = useRef(tags);
  tagsRef.current = tags;
  const mappingsRef = useRef(mappings);
  mappingsRef.current = mappings;
  const franchiseRef = useRef(franchise);
  franchiseRef.current = franchise;
  const authorRef = useRef(author);
  authorRef.current = author;
  // Bumped by every name check AND every keystroke in the name field, so a
  // slow answer for a name the person has since changed is thrown away rather
  // than filling the form from the wrong hack.
  const nameCheckSeqRef = useRef(0);
  const nameSuggestionRef = useRef<HTMLDivElement>(null);

  const nowYear = new Date().getFullYear();

  // Updates the ref IMMEDIATELY as well as the state. rowsRef is otherwise
  // only refreshed on render, but the send loop below keeps running
  // synchronously between awaits, before React has re-rendered: without this
  // the patch phase read a stale table in which no row was "created" yet,
  // found nothing to upload, and silently skipped every patch. (Caught by
  // driving the real component in a test, not by the type checker.)
  const patchRow = useCallback((key: string, changes: Partial<BulkRow>) => {
    rowsRef.current = rowsRef.current.map((r) => (r.key === key ? { ...r, ...changes } : r));
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...changes } : r)));
  }, []);

  // ───────────────────────── loading ─────────────────────────

  useEffect(() => {
    if (status !== 'authenticated') return;
    fetch('/api/submissions/batches')
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((d) =>
        setLimits({
          enabled: !!d.enabled,
          disabledMessage: d.disabledMessage ?? null,
          maxRows: d.limits.maxRows,
          maxBatchesPerDay: d.limits.maxBatchesPerDay,
          batchesUsedToday: d.batchesUsedToday,
        })
      )
      .catch(() => setSendError("Couldn't check your bulk-submit allowance — reload the page to try again."));
  }, [status]);

  // "Add several versions" arriving from a hack's page (?fromSubmission=<id>):
  // fill the shared details from that version, exactly what the single form's
  // "Add new version" does (same endpoint). Version, changelog and release
  // date are per-row, so nothing there is carried over. Best-effort.
  useEffect(() => {
    if (!fromSubmissionId || status !== 'authenticated') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/submissions/${fromSubmissionId}/version-prefill`);
        if (!res.ok || cancelled) return;
        const d = await res.json();
        if (cancelled) return;
        if (typeof d.hackName === 'string') setHackName(d.hackName);
        if (typeof d.platform === 'string') setPlatform(d.platform);
        if (typeof d.description === 'string') setDescription(d.description);
        if (typeof d.sourceUrl === 'string') setSourceUrl(d.sourceUrl);
        if (typeof d.releasePageUrl === 'string') setReleasePageUrl(d.releasePageUrl);
        if (typeof d.githubUrl === 'string') setGithubUrl(d.githubUrl);
        if (Array.isArray(d.tags)) setTags(d.tags);
        if (Array.isArray(d.translationLanguages)) setTranslationLanguages(d.translationLanguages);
        if (d.gameDatabaseLinks && typeof d.gameDatabaseLinks === 'object') setMappings(d.gameDatabaseLinks);
        if (d.baseRom) setBaseRom(d.baseRom);
        if (d.franchise) setFranchise(d.franchise);
        if (d.author) setAuthor(d.author);
        else if (typeof d.authorName === 'string' && d.authorName) setLegacyAuthor(d.authorName);
        setPrefillNote(d.hackName ?? null);
      } catch {
        /* a convenience, not a gate — worst case they fill it in by hand */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fromSubmissionId, status]);

  // ───────────────────────── derived ─────────────────────────

  const header: BulkHeader = useMemo(
    () => ({
      hackName,
      platform,
      description,
      sourceUrl,
      releasePageUrl,
      githubUrl,
      tags,
      translationLanguages,
      mappings,
      baseRomId: baseRom?.id ?? null,
      authorId: author?.id ?? null,
      legacyAuthor,
      franchiseId: franchise?.id ?? null,
    }),
    [hackName, platform, description, sourceUrl, releasePageUrl, githubUrl, tags, translationLanguages, mappings, baseRom, author, legacyAuthor, franchise]
  );

  const ordered = useMemo(() => sortRows(rows, sortMode), [rows, sortMode]);
  const flaggedDates = useMemo(
    () => dateOrderIssues(rows.map((r) => ({ key: r.key, version: r.version, releaseDate: r.releaseDate }))),
    [rows]
  );
  const checkByKey = useMemo(() => new Map((precheck?.rows ?? []).map((r) => [r.clientId, r])), [precheck]);
  const issuesByKey = useMemo(
    () =>
      new Map(
        ordered.map((r) => [
          r.key,
          computeRowIssues(r, {
            header: { hackName, sourceUrl },
            // A row that already exists would "duplicate" itself in the check.
            check: r.phase === 'created' ? undefined : checkByKey.get(r.key),
            dateOutOfOrder: flaggedDates.has(r.key),
            nowYear,
          }),
        ])
      ),
    [ordered, hackName, sourceUrl, checkByKey, flaggedDates, nowYear]
  );

  const baseUsable = !!baseFile && !!precheck?.baseRom && baseFile.sha1 === precheck.baseRom.sha1;
  const baseMismatch = !!baseFile && !!precheck?.baseRom && baseFile.sha1 !== precheck.baseRom.sha1;
  const verifyBytes: Uint8Array | null = baseUsable ? baseFile!.bytes : cachedBase;

  const pendingRows = ordered.filter((r) => r.phase !== 'created');
  const createdRows = ordered.filter((r) => r.phase === 'created');
  const patchWorkLeft = createdRows.filter((r) => r.patchKey && r.submissionId && r.patchPhase !== 'uploaded' && r.patchPhase !== 'skipped');
  const unplacedPatches = patches.filter((p) => !rows.some((r) => r.patchKey === p.key));
  const anyReading = rows.some((r) => !r.hash && !r.hashError);

  const headerProblem = !hackName.trim()
    ? 'Enter the hack\'s name.'
    : !platform
    ? 'Choose the platform.'
    : !baseRom
    ? 'Choose the base ROM these versions are patched from.'
    : precheck?.baseRomError ?? null;
  const rowsBlocked = pendingRows.some((r) => (issuesByKey.get(r.key)?.errors.length ?? 0) > 0);
  const rowsUnacked = pendingRows.filter((r) => issuesByKey.get(r.key) && needsAck(issuesByKey.get(r.key)!, r));
  const overCap = !!limits && rows.length > limits.maxRows;
  const checkSettled = !checking && (precheck !== null || checkFailed !== null);
  const needsCreate = pendingRows.length > 0;

  const canSend =
    !sending &&
    !!limits?.enabled &&
    (needsCreate
      ? !headerProblem && !anyReading && !rowsBlocked && rowsUnacked.length === 0 && !overCap && checkSettled
      : patchWorkLeft.length > 0);

  const allDone = rows.length > 0 && pendingRows.length === 0 && patchWorkLeft.length === 0 && !sending;
  const hasTranslationTag = tags.some((slug) => TRANSLATION_TRIGGER_SLUGS.includes(slug));

  // ───────────────────────── hashing ─────────────────────────

  // One file at a time: ROMs can be large, and the hasher is the heavy part.
  useEffect(() => {
    if (hashingRef.current || hashQueueRef.current.length === 0) return;
    hashingRef.current = true;
    (async () => {
      try {
        while (hashQueueRef.current.length > 0) {
          const key = hashQueueRef.current.shift()!;
          const row = rowsRef.current.find((r) => r.key === key);
          if (!row) continue; // removed while waiting
          try {
            const h = await computeAllHashes(row.file, (p) => patchRow(key, { hashProgress: p }));
            patchRow(key, { hash: h, hashProgress: 100, phase: 'ready' });
          } catch (err) {
            console.error('[bulk] hashing failed:', err);
            patchRow(key, { hashError: "Couldn't read this file — remove it and add it again.", phase: 'failed' });
          }
        }
      } finally {
        hashingRef.current = false;
      }
    })();
  }, [hashKick, patchRow]);

  // ───────────────────────── matching an existing hack ─────────────────────────

  const mark = (fields: string[]) =>
    setAutoFilled((prev) => (fields.every((f) => prev.has(f)) ? prev : new Set([...Array.from(prev), ...fields])));
  const unmark = (field: string) =>
    setAutoFilled((prev) => {
      if (!prev.has(field)) return prev;
      const next = new Set(prev);
      next.delete(field);
      return next;
    });

  // Single funnels for franchise / author, so the state, the ref and the
  // "auto-filled" marker can never disagree (same idea as the single form's
  // applyFranchise/applyAuthor). `auto` = filled in by the site, not picked.
  const applyFranchise = (next: SelectedFranchise | null, auto = false) => {
    franchiseRef.current = next;
    setFranchise(next);
    if (auto) mark(['franchise']);
    else unmark('franchise');
  };
  const applyAuthor = (next: SelectedAuthor | null, auto = false) => {
    authorRef.current = next;
    setAuthor(next);
    // A real pick (or an explicit removal) always supersedes a carried-over
    // plain-text name — the two are never both live.
    setLegacyAuthor(null);
    if (auto) mark(['author']);
    else unmark('author');
  };
  // A plain author NAME carried over from a hack whose author was never linked
  // to the Author list (null = the person dismissed it).
  const applyLegacyAuthor = (name: string | null, auto = false) => {
    setLegacyAuthor(name);
    if (auto && name) mark(['author']);
    else unmark('author');
  };

  // The person edits a field: it's theirs now, so the marker goes.
  const changePlatform = (value: string) => {
    platformRef.current = value;
    setPlatform(value);
    unmark('platform');
    // Same name on a different platform is a different hack — look again.
    if (hackNameRef.current.trim()) void checkSimilarName(hackNameRef.current, value);
  };
  const changeDescription = (value: string) => {
    descriptionRef.current = value;
    setDescription(value);
    unmark('description');
  };
  const changeTags = (value: string[]) => {
    tagsRef.current = value;
    setTags(value);
    unmark('tags');
  };

  // Fills the shared details from an existing hack — what the single form's
  // applyFamilyPrefill does. Only ever fills what is still EMPTY (see
  // planFamilyPrefill); never version, changelog, release date, source URL or
  // patch, which belong to each version. Best-effort: a failure just means
  // the person fills things in by hand.
  const applyFamilyPrefill = async (familyId: string, seq: number) => {
    try {
      const res = await fetch(`/api/entries/hack-family/${familyId}`);
      if (!res.ok) return;
      const data = await res.json();
      if (seq !== nameCheckSeqRef.current) return; // the name changed while this loaded
      // Once something has been submitted the shared details are settled for
      // this batch — don't change them underneath it.
      if (rowsRef.current.some((r) => r.phase === 'created')) return;
      const plan = planFamilyPrefill(
        {
          platform: platformRef.current,
          description: descriptionRef.current,
          tags: tagsRef.current,
          mappings: mappingsRef.current,
          hasFranchise: !!franchiseRef.current,
          hasAuthor: !!authorRef.current,
        },
        data
      );
      if (plan.filled.length === 0) return;
      if (plan.platform !== undefined) {
        platformRef.current = plan.platform;
        setPlatform(plan.platform);
      }
      if (plan.description !== undefined) {
        descriptionRef.current = plan.description;
        setDescription(plan.description);
      }
      if (plan.tags) {
        tagsRef.current = plan.tags;
        setTags(plan.tags);
      }
      if (plan.mappings) {
        mappingsRef.current = plan.mappings;
        setMappings(plan.mappings);
      }
      if (plan.franchise) applyFranchise(plan.franchise, true);
      if (plan.author) applyAuthor(plan.author, true);
      else if (plan.legacyAuthor) applyLegacyAuthor(plan.legacyAuthor, true);
      mark(plan.filled);
    } catch {
      /* a convenience, not a gate */
    }
  };

  // Does this name (on this platform) match an existing hack? An exact match
  // fills the shared details in (unless `prefill: false`); a near match
  // becomes a "did you mean…?" prompt. Returns what it found, or null when
  // there was nothing to check, it failed, or a newer check replaced it.
  const checkSimilarName = async (name: string, plat: string, opts?: { prefill?: boolean }): Promise<NameCheck | null> => {
    const seq = ++nameCheckSeqRef.current;
    if (!name.trim() || !plat) {
      setNameCheck(null);
      return null;
    }
    try {
      const res = await fetch(
        `/api/submissions/check-similar-name?name=${encodeURIComponent(name)}&platform=${encodeURIComponent(plat)}`
      );
      if (!res.ok) return null;
      const data = (await res.json()) as NameCheck;
      if (seq !== nameCheckSeqRef.current) return null;
      setNameCheck(data);
      if (data.exactMatch && opts?.prefill !== false) await applyFamilyPrefill(data.exactMatch.id, seq);
      return data;
    } catch {
      // A convenience check, not a hard gate — a hiccup here shouldn't block the form.
      return null;
    }
  };

  // A suggestion picked from the name field's dropdown: unambiguous, and it
  // knows its own platform.
  const handleSuggestionSelect = (s: HackFamilySuggestion) => {
    hackNameRef.current = s.name;
    setHackName(s.name);
    if (!platformRef.current) {
      platformRef.current = s.platform;
      setPlatform(s.platform);
    }
    void checkSimilarName(s.name, s.platform);
  };

  // The name was just guessed from the dropped files' names. Same rule as the
  // single form: if exactly ONE existing hack matches it, adopt that hack (its
  // spelling, and — once the name check runs — its details); with none or
  // several, guess nothing. Skipped if the person has started typing a
  // different name in the meantime.
  const resolveGuessedName = async (guess: string) => {
    try {
      const params = new URLSearchParams({ q: guess });
      if (platformRef.current) params.set('platform', platformRef.current);
      const res = await fetch(`/api/entries/autocomplete?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json();
      const matches: HackFamilySuggestion[] = Array.isArray(data.suggestions) ? data.suggestions : [];
      if (matches.length === 1 && hackNameRef.current.trim() === guess) handleSuggestionSelect(matches[0]);
    } catch {
      /* best-effort */
    }
  };

  // ───────────────────────── intake ─────────────────────────

  const addRoms = async (files: File[]) => {
    setSendError(null);
    setIntakeBusy(true);
    try {
      const collected: File[] = [];
      const newNotes: string[] = [];
      for (const f of files) {
        const r = await expandDropped(f, 'rom');
        collected.push(...r.files);
        newNotes.push(...r.notes);
      }
      const have = new Set(rowsRef.current.map((r) => `${r.filename}:${r.fileSize}`));
      const fresh: File[] = [];
      let repeats = 0;
      for (const f of collected) {
        const id = `${f.name}:${f.size}`;
        if (have.has(id)) repeats++;
        else {
          have.add(id);
          fresh.push(f);
        }
      }
      if (repeats) newNotes.push(`${repeats} file${repeats === 1 ? ' was' : 's were'} already in the list, so ${repeats === 1 ? 'it was' : 'they were'} skipped.`);

      const capacity = limits ? Math.max(0, limits.maxRows - rowsRef.current.length) : Infinity;
      const taken = fresh.slice(0, capacity);
      if (taken.length < fresh.length && limits) {
        newNotes.push(`Your account can submit up to ${limits.maxRows} versions at a time, so ${fresh.length - taken.length} file${fresh.length - taken.length === 1 ? ' was' : 's were'} left out. Submit these, then start another batch.`);
      }

      const newRows: BulkRow[] = taken.map((f) => {
        const guess = versionFromFilename(f.name);
        return {
          key: nextKey('r'),
          file: f,
          filename: f.name,
          fileSize: f.size,
          hash: null,
          hashProgress: 0,
          hashError: null,
          version: guess ?? '',
          versionAuto: !!guess,
          releaseDate: '',
          changelog: '',
          sourceUrl: '',
          patchKey: null,
          patchConfidence: null,
          verify: null,
          phase: 'hashing',
          error: null,
          submissionId: null,
          patchPhase: 'idle',
          patchError: null,
          ackedWarnings: '',
        };
      });

      // The most common name among the dropped files fills in the hack name,
      // only while it's still empty.
      if (!hackName.trim() && newRows.length > 0) {
        const counts = new Map<string, number>();
        for (const r of newRows) {
          const n = hackNameFromFilename(r.filename).trim();
          if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
        }
        const best = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
        if (best) {
          hackNameRef.current = best[0];
          setHackName(best[0]);
          void resolveGuessedName(best[0]);
        }
      }

      if (newRows.length > 0) {
        hashQueueRef.current.push(...newRows.map((r) => r.key));
        setRows((prev) => [...prev, ...newRows]);
        setHashKick((k) => k + 1);
      }
      if (newNotes.length > 0) setNotes((n) => [...n, ...newNotes]);
    } finally {
      setIntakeBusy(false);
    }
  };

  const addPatches = async (files: File[]) => {
    setSendError(null);
    setIntakeBusy(true);
    try {
      const collected: File[] = [];
      const newNotes: string[] = [];
      for (const f of files) {
        const r = await expandDropped(f, 'patch');
        collected.push(...r.files);
        newNotes.push(...r.notes);
      }
      const have = new Set(patchesRef.current.map((p) => `${p.filename}:${p.file.size}`));
      const entries: PatchEntry[] = [];
      for (const f of collected) {
        const id = `${f.name}:${f.size}`;
        if (have.has(id)) continue;
        have.add(id);
        entries.push({ key: nextKey('p'), file: f, filename: f.name, patchType: patchTypeFromFilename(f.name), sha1: null, error: null });
      }
      if (entries.length > 0) {
        setPatches((prev) => [...prev, ...entries]);
        for (const entry of entries) {
          sha1Hex(entry.file)
            .then((sha1) => setPatches((prev) => prev.map((p) => (p.key === entry.key ? { ...p, sha1 } : p))))
            .catch((err) =>
              setPatches((prev) =>
                prev.map((p) => (p.key === entry.key ? { ...p, error: err instanceof Error ? err.message : "Couldn't read this patch." } : p))
              )
            );
        }
      }
      if (newNotes.length > 0) setNotes((n) => [...n, ...newNotes]);
    } finally {
      setIntakeBusy(false);
    }
  };

  const addBaseFile = async (files: File[]) => {
    setBaseBusy(true);
    try {
      const r = await expandDropped(files[0], 'rom');
      if (r.files.length === 0) {
        setNotes((n) => [...n, ...r.notes]);
        return;
      }
      const f = r.files[0];
      const sha1 = await sha1Hex(f);
      setBaseFile({ name: f.name, sha1, bytes: new Uint8Array(await f.arrayBuffer()) });
    } catch (err) {
      setNotes((n) => [...n, err instanceof Error ? err.message : "Couldn't read that base ROM file."]);
    } finally {
      setBaseBusy(false);
    }
  };

  // ───────────────────────── patch pairing ─────────────────────────

  // Pairs whatever is still free. Only rows with no patch whose pairing the
  // person hasn't set by hand take part, and only patches not already placed —
  // so a pairing the person chose is never overridden.
  const pairKey =
    rows.map((r) => `${r.key}:${r.version}:${r.patchKey ?? ''}:${r.patchConfidence ?? ''}:${r.phase}`).join(',') +
    '|' +
    patches.map((p) => p.key).join(',');
  useEffect(() => {
    const free = rowsRef.current.filter((r) => !r.patchKey && r.patchConfidence !== 'manual' && r.phase !== 'created');
    const used = new Set(rowsRef.current.map((r) => r.patchKey).filter(Boolean));
    const freePatches = patchesRef.current.filter((p) => !used.has(p.key));
    if (free.length === 0 || freePatches.length === 0) return;
    const { pairs } = pairPatches(
      free.map((r) => ({ key: r.key, filename: r.filename, version: r.version })),
      freePatches.map((p) => ({ key: p.key, filename: p.filename }))
    );
    if (pairs.size === 0) return;
    setRows((rs) =>
      rs.map((r) => {
        const pair = pairs.get(r.key);
        return pair ? { ...r, patchKey: pair.patchKey, patchConfidence: pair.confidence, verify: null } : r;
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairKey]);

  const choosePatch = (rowKey: string, patchKey: string | null) => {
    setRows((rs) =>
      rs.map((r) => {
        if (r.key === rowKey) return { ...r, patchKey, patchConfidence: 'manual', verify: null };
        // A patch belongs to one version — choosing it here takes it from wherever it was.
        if (patchKey && r.patchKey === patchKey) return { ...r, patchKey: null, patchConfidence: null, verify: null };
        return r;
      })
    );
  };

  // ───────────────────────── proving patches ─────────────────────────

  // The base ROM may already be saved in this browser from using "patch your
  // ROM" on another page — if so, no need to ask for it.
  useEffect(() => {
    const sha1 = precheck?.baseRom?.sha1;
    if (!sha1 || cachedBase || baseFile) return;
    let cancelled = false;
    getCachedRom(sha1)
      .then((hit) => {
        if (!cancelled && hit) setCachedBase(hit.bytes);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [precheck?.baseRom?.sha1, cachedBase, baseFile]);

  // A different base ROM invalidates everything proven against the old one.
  const baseRomId = baseRom?.id ?? null;
  useEffect(() => {
    setBaseFile(null);
    setCachedBase(null);
    setRows((rs) => rs.map((r) => (r.verify ? { ...r, verify: null } : r)));
  }, [baseRomId]);

  const verifyKey =
    rows.map((r) => (r.patchKey && r.hash && r.verify === null && r.phase !== 'created' ? `${r.key}:${r.patchKey}:${r.hash.sha1}` : '')).join('|') +
    (verifyBytes ? '#B' : '') +
    patches.map((p) => (p.sha1 ? '1' : '0')).join('') +
    verifyTick;
  useEffect(() => {
    if (!verifyBytes || verifyingRef.current) return;
    const todo = rowsRef.current.filter((r) => r.patchKey && r.hash && r.verify === null && r.phase !== 'created');
    if (todo.length === 0) return;
    verifyingRef.current = true;
    (async () => {
      try {
        for (const row of todo) {
          const patch = patchesRef.current.find((p) => p.key === row.patchKey);
          if (!patch || !row.hash) continue;
          patchRow(row.key, { verify: 'running' });
          const result = await verifyPatchProducesRom({
            patchType: patch.patchType,
            patchFile: patch.file,
            baseRomBytes: verifyBytes,
            expectedSha1: row.hash.sha1,
          });
          // Only if the pairing wasn't changed while this was running.
          setRows((rs) => rs.map((r) => (r.key === row.key && r.patchKey === row.patchKey ? { ...r, verify: result } : r)));
        }
      } finally {
        verifyingRef.current = false;
        setVerifyTick((t) => t + 1); // pick up anything that changed meanwhile
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verifyKey]);

  // ───────────────────────── dry-run check ─────────────────────────

  const checkKey = JSON.stringify([
    hackName.trim(),
    platform,
    baseRom?.id ?? null,
    // Over EVERY hashed row, created or not: a row becoming "created" must not
    // look like a change, or Retry would sit disabled for a second re-checking
    // rows whose results can't have changed. (Only not-yet-created rows are
    // actually sent to the check, below.)
    rows.filter((r) => r.hash).map((r) => [r.key, r.version.trim(), r.hash!.sha1]),
  ]);
  useEffect(() => {
    const checkable = rowsRef.current.filter((r) => r.hash && r.phase !== 'created');
    // A base ROM is NOT needed for the check to be useful (duplicate files,
    // repeats, an existing version label), so it runs as soon as there is a
    // name, a platform and a hashed file — not only once a base ROM is picked.
    if (!hackName.trim() || !platform || checkable.length === 0) {
      setPrecheck(null);
      setCheckFailed(null);
      setChecking(false);
      return;
    }
    const seq = ++checkSeqRef.current;
    setChecking(true);
    // Debounced: re-runs as version labels are typed, and the server limits
    // how often this can be called.
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/submissions/precheck', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            hackName: hackName.trim(),
            platform,
            ...(baseRom ? { baseRomId: baseRom.id } : {}),
            rows: checkable.map((r) => ({ clientId: r.key, version: r.version.trim(), sha1: r.hash!.sha1 })),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (seq !== checkSeqRef.current) return; // a newer check superseded this one
        if (res.ok) {
          setPrecheck(data);
          setCheckFailed(null);
        } else {
          setPrecheck(null);
          setCheckFailed(data.error ?? "Couldn't run the pre-check.");
        }
      } catch {
        if (seq === checkSeqRef.current) {
          setPrecheck(null);
          setCheckFailed("Couldn't run the pre-check.");
        }
      } finally {
        if (seq === checkSeqRef.current) setChecking(false);
      }
    }, 1200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkKey]);

  // Files only live in this tab — leaving mid-way loses them.
  useEffect(() => {
    if (!sending && pendingRows.length === 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [sending, pendingRows.length]);

  // ───────────────────────── sending ─────────────────────────

  const send = async () => {
    setSending(true);
    setSendError(null);
    try {
      // 0) The name checks above are early warnings; this is the guaranteed one
      //    (same as the single form's submit). A near match the person hasn't
      //    answered stops here, BEFORE any batch exists, so a typo can't quietly
      //    start a second, disconnected copy of an existing hack. An exact
      //    match needs no decision. Skipped on Retry (the batch already exists).
      if (needsCreate && !batchIdRef.current && dismissedSuggestionFor !== hackName) {
        const fresh = await checkSimilarName(hackName, platform, { prefill: false });
        if (fresh && !fresh.exactMatch && fresh.suggestions.length > 0) {
          nameSuggestionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setSendError('A hack with a similar name already exists — use that name, or choose "No, this is different", before submitting.');
          return;
        }
      }

      // 1) One batch for the whole sitting.
      let batchId = batchIdRef.current;
      if (needsCreate && !batchId) {
        const res = await fetch('/api/submissions/batches', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hackName: hackName.trim(), platform }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setSendError(data.error ?? "Couldn't start the batch.");
          return;
        }
        batchId = data.batch.id as string;
        batchIdRef.current = batchId;
      }
      if (!batchId) batchId = batchIdRef.current;
      if (!batchId) return;

      // 2) Versions, oldest first, one request at a time. A failure on one
      //    row never undoes the others; only a limit or lost connection
      //    stops the loop, and whatever's left is simply tried again on Retry.
      let promoted = false;
      let stopped = false;
      const todo = sortRows(rowsRef.current, sortModeRef.current).filter((r) => r.phase === 'ready' || r.phase === 'failed');
      for (const row of todo) {
        if (stopped) break;
        if (!row.hash) continue;
        patchRow(row.key, { phase: 'sending', error: null });
        const patch = patchesRef.current.find((p) => p.key === row.patchKey) ?? null;
        let res: Response;
        try {
          res = await fetch('/api/submissions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildCreatePayload({ header, row, patch, batchId })),
          });
        } catch {
          patchRow(row.key, { phase: 'ready', error: null });
          setSendError('Lost connection. Whatever was already submitted is safe — check your connection and press Retry.');
          stopped = true;
          continue;
        }
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          // 200 + alreadyCreated is a retry finding its own earlier row.
          patchRow(row.key, { phase: 'created', submissionId: data.submission.id, error: null });
          if (data.promotedToContributor) promoted = true;
        } else if (res.status === 429 || res.status === 503) {
          patchRow(row.key, { phase: 'ready', error: null });
          setSendError(
            res.status === 429
              ? `${data.error ?? 'Too many requests.'} Wait a little, then press Retry — everything already submitted is kept.`
              : data.error ?? 'Bulk submitting is paused right now.'
          );
          stopped = true;
        } else if (res.status === 409 && data.duplicate) {
          patchRow(row.key, { phase: 'failed', error: 'This exact file is already in HackHash.' });
        } else {
          patchRow(row.key, { phase: 'failed', error: describeValidationError(data.details) ?? data.error ?? 'Submission failed.' });
        }
      }
      if (promoted) await updateSession();
      if (stopped) return;

      // 3) Patches, one at a time (the upload route holds a whole file in
      //    memory). Each goes through the ordinary patch route, which does
      //    its own validation, so a bad file fails on its own row and the
      //    version is still submitted.
      const withPatch = sortRows(rowsRef.current, sortModeRef.current).filter(
        (r) => r.phase === 'created' && r.patchKey && r.submissionId && r.patchPhase !== 'uploaded' && r.patchPhase !== 'skipped'
      );
      for (let i = 0; i < withPatch.length; i++) {
        const row = withPatch[i];
        const patch = patchesRef.current.find((p) => p.key === row.patchKey);
        if (!patch) continue;
        patchRow(row.key, { patchPhase: 'uploading', patchError: null });
        const form = new FormData();
        form.append('file', patch.file, patch.filename);
        let res: Response;
        try {
          res = await fetch(`/api/submissions/${row.submissionId}/patch?batch=${encodeURIComponent(batchId)}`, { method: 'POST', body: form });
        } catch {
          patchRow(row.key, { patchPhase: 'failed', patchError: 'Lost connection.' });
          setSendError('Lost connection while uploading patches. The versions are submitted — press Retry to upload the rest.');
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          patchRow(row.key, { patchPhase: 'uploaded', patchError: null });
        } else if (res.status === 503 && data.uploadsDisabled) {
          for (const r of withPatch.slice(i)) patchRow(r.key, { patchPhase: 'skipped', patchError: null });
          setSendError('Patch uploads are paused right now. Your versions were submitted — you can attach each patch from its own page later.');
          return;
        } else if (res.status === 429) {
          patchRow(row.key, { patchPhase: 'failed', patchError: data.error ?? 'Too many requests.' });
          setSendError('Patch uploads hit a rate limit. Wait a little, then press Retry to upload the rest.');
          return;
        } else {
          patchRow(row.key, { patchPhase: 'failed', patchError: data.error ?? 'Upload failed.' });
        }
      }
    } finally {
      setSending(false);
    }
  };

  const removeRow = (key: string) => setRows((rs) => rs.filter((r) => r.key !== key));
  const ackRow = (row: BulkRow) => {
    const issues = issuesByKey.get(row.key);
    if (!issues) return;
    // Ticking records exactly which warnings were seen; unticking clears it.
    patchRow(row.key, { ackedWarnings: needsAck(issues, row) ? warningSignature(issues) : '' });
  };
  const ackAll = () => {
    setRows((rs) =>
      rs.map((r) => {
        const issues = issuesByKey.get(r.key);
        return issues && r.phase !== 'created' && issues.warnings.length > 0 ? { ...r, ackedWarnings: warningSignature(issues) } : r;
      })
    );
  };

  // ───────────────────────── render ─────────────────────────

  if (status === 'loading') {
    return <div className="h-24 rounded-lg bg-bg-elevated border border-border animate-pulse" />;
  }
  if (status !== 'authenticated') {
    return (
      <div className="p-6 rounded-lg border border-border bg-bg-surface space-y-3">
        <p className="text-text-primary font-medium">Sign in to submit</p>
        <p className="text-sm text-text-secondary">You need an account to submit ROM hacks.</p>
        <Button onClick={() => router.push(`/auth/signin?callbackUrl=${encodeURIComponent('/submit/bulk')}`)}>Sign in</Button>
      </div>
    );
  }
  if (limits && !limits.enabled) {
    return (
      <div className="p-6 rounded-lg border border-border bg-bg-surface space-y-3" role="status">
        <p className="text-text-primary font-medium">Bulk submitting is paused</p>
        <p className="text-sm text-text-secondary">{limits.disabledMessage}</p>
        <Link href="/submit"><Button variant="secondary">Submit one version</Button></Link>
      </div>
    );
  }

  // The "arrived from a hack's page" banner is about ONE hack; once the name
  // is changed to something else it would be wrong, and the name check below
  // speaks for the new name instead.
  const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const showPrefillNote = !!prefillNote && sameName(prefillNote, hackName);
  const showExactMatch = !!nameCheck?.exactMatch && !showPrefillNote;
  const showNearMatch =
    !nameCheck?.exactMatch && !!nameCheck && nameCheck.suggestions.length > 0 && dismissedSuggestionFor !== hackName;

  const attention = pendingRows.filter((r) => {
    const i = issuesByKey.get(r.key);
    return i && (i.errors.length > 0 || needsAck(i, r));
  }).length;
  const sendLabel = createdRows.length > 0 || patchWorkLeft.length > 0 ? (needsCreate ? `Retry remaining (${pendingRows.length})` : 'Retry patch uploads') : `Submit ${pendingRows.length} version${pendingRows.length === 1 ? '' : 's'}`;

  return (
    <div className="space-y-8">
      {showPrefillNote && (
        <div className="rounded-lg border border-phosphor/30 bg-phosphor/5 p-3 text-sm text-text-secondary flex items-start gap-2">
          <Info size={16} className="text-phosphor shrink-0 mt-0.5" />
          <span>Adding more versions of <span className="text-text-primary font-medium">{prefillNote}</span>. The details below came from an existing version — check them.</span>
        </div>
      )}

      {/* ── About the hack ── */}
      <section className="rounded-lg border border-border bg-bg-surface p-5 space-y-4" aria-labelledby="bulk-about">
        <div>
          <h2 id="bulk-about" className="font-display text-lg font-bold">About the hack</h2>
          <p className="text-xs text-text-muted mt-0.5">Entered once, used for every version below.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Hack name" required hint="Start typing to see hacks already on HackHash.">
            {/* Same name field as the single form: suggestions as you type, and a
                check against existing hacks when you leave it. */}
            <HackNameAutocomplete
              value={hackName}
              onChange={(v) => {
                hackNameRef.current = v;
                setHackName(v);
                setNameCheck(null);
                nameCheckSeqRef.current++; // a check still in flight is about a name that's gone
              }}
              onSelect={handleSuggestionSelect}
              onBlur={(v) => void checkSimilarName(v, platformRef.current)}
              platform={platform || undefined}
              placeholder="24 Hour Hack"
              className={inputClass}
              maxLength={200}
              disabled={sending}
            />
          </Field>
          <Field label="Platform" required autoFilled={autoFilled.has('platform')}>
            <select className={inputClass} value={platform} disabled={sending || createdRows.length > 0} onChange={(e) => changePlatform(e.target.value)}>
              <option value="">Choose…</option>
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>
              ))}
            </select>
          </Field>
        </div>
        {/* Near match — only while there's no exact match, and the person hasn't
            already said this one is a different hack. */}
        {showNearMatch && nameCheck && (
          <div ref={nameSuggestionRef} className="p-3 rounded-lg bg-status-pending-bg border border-status-pending/30" role="status">
            <p className="text-sm text-text-primary">
              Did you mean <strong>{nameCheck.suggestions[0].name}</strong>? A hack with a similar name already exists on this platform.
            </p>
            <div className="flex gap-2 mt-2">
              <button
                type="button"
                disabled={sending}
                onClick={() => {
                  const matchName = nameCheck.suggestions[0].name;
                  hackNameRef.current = matchName;
                  setHackName(matchName);
                  void checkSimilarName(matchName, platform);
                }}
                className="px-2.5 py-1 rounded-md text-xs font-medium bg-status-pending/20 text-status-pending hover:bg-status-pending/30 transition-colors disabled:opacity-40"
              >
                Use this name
              </button>
              <button
                type="button"
                disabled={sending}
                onClick={() => setDismissedSuggestionFor(hackName)}
                className="px-2.5 py-1 rounded-md text-xs font-medium border border-border text-text-muted hover:border-phosphor/30 transition-colors disabled:opacity-40"
              >
                No, this is different
              </button>
            </div>
          </div>
        )}

        {/* Exact match — these versions join that hack. Whatever shared details
            it has and this form was still missing were filled in above and are
            marked "auto-filled". Nothing already on the hack is changed:
            bulk submits never rewrite the other versions' details. */}
        {showExactMatch && nameCheck?.exactMatch && (
          <div className="p-3 rounded-lg bg-phosphor/5 border border-phosphor/20" role="status">
            <p className="text-sm text-text-primary flex items-start gap-1.5">
              <Sparkles size={14} className="text-phosphor shrink-0 mt-0.5" />
              <span>
                <strong>{nameCheck.exactMatch.name}</strong> is already on HackHash — these will be added to it as new versions.
                Any of its shared details this form was still missing (description, tags, author, franchise, game database links)
                were pre-filled and marked <em>auto-filled</em>; check they&apos;re still right for these versions. The versions
                already there are not changed.
              </span>
            </p>
          </div>
        )}

        {platform && (
          <Field label="Base ROM" required hint="The unpatched game these versions are patched from. Pick an approved one, or hash your own.">
            <BaseRomPicker platform={platform} value={baseRom} onChange={setBaseRom} />
          </Field>
        )}
        {precheck?.baseRomError && <p className="text-xs text-status-rejected" role="alert">{precheck.baseRomError}</p>}
        {precheck?.baseRomWarning && <p className="text-xs text-status-pending">{precheck.baseRomWarning}</p>}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Author" autoFilled={autoFilled.has('author')}>
            <AuthorPicker value={author} onChange={(next) => applyAuthor(next)} initialQuery={legacyAuthor ?? undefined} />
            {!author && legacyAuthor && (
              <p className="mt-1.5 text-xs text-text-secondary">
                Carried over from an earlier version: &ldquo;{legacyAuthor}&rdquo; (not on the author list yet). Search above to link it, or{' '}
                <button type="button" onClick={() => applyLegacyAuthor(null)} className="text-phosphor hover:underline">
                  leave it blank
                </button>
                .
              </p>
            )}
          </Field>
          <Field label="Franchise" autoFilled={autoFilled.has('franchise')}>
            <FranchisePicker value={franchise} onChange={(next) => applyFranchise(next)} />
          </Field>
        </div>
        <Field label="Default source URL" required hint="Where this hack is published. Any version can use its own instead.">
          <input className={inputClass} value={sourceUrl} placeholder="https://…" disabled={sending} onChange={(e) => setSourceUrl(e.target.value)} />
        </Field>
        <Field label="Description" autoFilled={autoFilled.has('description')}>
          <textarea className={`${inputClass} resize-y`} rows={3} maxLength={5000} value={description} disabled={sending} onChange={(e) => changeDescription(e.target.value)} />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Release page URL">
            <input className={inputClass} value={releasePageUrl} placeholder="https://…" disabled={sending} onChange={(e) => setReleasePageUrl(e.target.value)} />
          </Field>
          <Field label="GitHub URL">
            <input className={inputClass} value={githubUrl} placeholder="https://github.com/…" disabled={sending} onChange={(e) => setGithubUrl(e.target.value)} />
          </Field>
        </div>
        <TagsEditor value={tags} onChange={changeTags} autoFilled={autoFilled.has('tags')} />
        {hasTranslationTag && <LanguagePicker value={translationLanguages} onChange={setTranslationLanguages} />}
        <MappingsSection values={mappings} onChange={setMappings} />
      </section>

      {/* ── Files ── */}
      <section className="space-y-4" aria-labelledby="bulk-files">
        <div>
          <h2 id="bulk-files" className="font-display text-lg font-bold">The versions</h2>
          <p className="text-xs text-text-muted mt-0.5">
            Drop every ROM at once — zip, 7z, RAR and gz archives are opened here. Your ROMs are read in your browser and never uploaded.
            {limits && <> Your account can submit up to {limits.maxRows} at a time.</>}
          </p>
        </div>
        <BulkDropZone
          label={intakeBusy ? 'Reading…' : 'Drop the ROMs for every version here'}
          hint="Or click to choose files. A zip holding several versions becomes one row each."
          onFiles={addRoms}
          disabled={sending || intakeBusy || (!!limits && rows.length >= limits.maxRows)}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <BulkDropZone
            compact
            label="Patches (optional)"
            hint="Drop patch files too — they're paired with versions by name, and only when it's clear."
            onFiles={addPatches}
            disabled={sending || intakeBusy}
          />
          <BulkDropZone
            compact
            multiple={false}
            label={baseBusy ? 'Reading…' : baseUsable || cachedBase ? 'Base ROM ready' : 'Base ROM file (optional)'}
            hint="Lets HackHash prove each patch really produces its version, instead of trusting file names."
            onFiles={addBaseFile}
            disabled={sending || baseBusy || !baseRom}
          />
        </div>
        {cachedBase && !baseFile && <p className="text-xs text-text-muted">Using the base ROM already saved in this browser to check patches.</p>}
        {baseMismatch && (
          <p className="text-xs text-status-rejected" role="alert">
            That file isn&apos;t the selected base ROM{precheck?.baseRom ? ` (${precheck.baseRom.name})` : ''}, so it can&apos;t be used to check patches.
          </p>
        )}
        {unplacedPatches.length > 0 && (
          <div className="rounded-md border border-border bg-bg-surface p-3 space-y-1.5">
            <p className="text-xs text-text-secondary">
              {unplacedPatches.length} patch{unplacedPatches.length === 1 ? '' : 'es'} couldn&apos;t be matched to a version with confidence. Pick them from a version&apos;s Patch menu below:
            </p>
            <ul className="space-y-1">
              {unplacedPatches.map((p) => (
                <li key={p.key} className="flex items-center justify-between gap-2 text-xs text-text-primary">
                  <span className="truncate">{p.filename}{p.patchType ? ` (${patchTypeLabel(p.patchType)})` : ''}</span>
                  <button
                    type="button"
                    disabled={sending}
                    onClick={() => setPatches((ps) => ps.filter((x) => x.key !== p.key))}
                    aria-label={`Remove ${p.filename}`}
                    className="p-0.5 text-text-muted hover:text-status-rejected disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor/40 rounded"
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {notes.length > 0 && (
          <div className="rounded-md border border-status-pending/30 bg-status-pending/5 p-3 space-y-1" role="status">
            {notes.map((n, i) => (
              <p key={i} className="text-xs text-status-pending flex items-start gap-1.5"><AlertTriangle size={12} className="shrink-0 mt-0.5" /> {n}</p>
            ))}
            <button type="button" onClick={() => setNotes([])} className="text-xs text-text-muted hover:text-text-primary underline">Dismiss</button>
          </div>
        )}
      </section>

      {/* ── Rows ── */}
      {ordered.length > 0 && (
        <section className="space-y-3" aria-label="Versions to submit">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-sm text-text-secondary">
              {ordered.length} version{ordered.length === 1 ? '' : 's'}, submitted oldest first.
            </p>
            <div className="flex items-center gap-3">
              {rowsUnacked.length > 1 && (
                <button type="button" onClick={ackAll} disabled={sending} className="text-xs text-phosphor hover:underline disabled:opacity-40">
                  I&apos;ve checked all {rowsUnacked.length} warnings
                </button>
              )}
              <label className="text-xs text-text-muted flex items-center gap-1.5">
                Order by
                <select className="px-2 py-1 rounded-md bg-bg-surface border border-border text-xs text-text-primary" value={sortMode} disabled={sending} onChange={(e) => setSortMode(e.target.value as 'version' | 'date')}>
                  <option value="version">Version</option>
                  <option value="date">Release date</option>
                </select>
              </label>
            </div>
          </div>
          {ordered.map((row) => {
            const issues = issuesByKey.get(row.key)!;
            return (
              <BulkRowCard
                key={row.key}
                row={row}
                issues={issues}
                needsAck={needsAck(issues, row)}
                patches={patches}
                canVerify={!!verifyBytes}
                defaultSourceUrl={sourceUrl}
                locked={sending}
                onChange={(c) => patchRow(row.key, c)}
                onPatchChange={(k) => choosePatch(row.key, k)}
                onAck={() => ackRow(row)}
                onRemove={() => removeRow(row.key)}
              />
            );
          })}
        </section>
      )}

      {/* ── Send ── */}
      {rows.length > 0 && !allDone && (
        <section className="sticky bottom-0 -mx-4 sm:mx-0 px-4 sm:px-5 py-4 sm:rounded-lg border-t sm:border border-border bg-bg-base/95 backdrop-blur space-y-2" aria-label="Submit">
          {sendError && <p className="text-sm text-status-rejected" role="alert">{sendError}</p>}
          {overCap && limits && <p className="text-sm text-status-rejected" role="alert">Your account can submit up to {limits.maxRows} versions at a time — remove {rows.length - limits.maxRows}.</p>}
          {checkFailed && needsCreate && <p className="text-xs text-text-muted">The pre-check couldn&apos;t run ({checkFailed}). You can still submit — the server checks every version itself.</p>}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs text-text-secondary" aria-live="polite">
              {sending
                ? 'Submitting — keep this tab open…'
                : anyReading
                ? 'Reading files…'
                : checking && needsCreate
                ? 'Checking…'
                : headerProblem && needsCreate
                ? headerProblem
                : attention > 0
                ? `${attention} version${attention === 1 ? ' needs' : 's need'} attention above before submitting.`
                : createdRows.length > 0 && !needsCreate
                ? 'Some patches still need uploading.'
                : 'Everything checks out. Each version still goes through normal community verification.'}
            </p>
            <Button onClick={send} disabled={!canSend} loading={sending}>
              {sending ? <><Loader2 size={14} className="animate-spin mr-1" /> Submitting…</> : sendLabel}
            </Button>
          </div>
        </section>
      )}

      {allDone && (
        <section className="rounded-lg border border-phosphor/40 bg-phosphor/5 p-5 space-y-3" role="status">
          <p className="text-text-primary font-medium flex items-center gap-2"><CheckCircle2 size={18} className="text-phosphor" /> Submitted {createdRows.length} version{createdRows.length === 1 ? '' : 's'}</p>
          <p className="text-sm text-text-secondary">Each one is now pending community verification.{createdRows.some((r) => r.patchPhase === 'skipped') && ' Some patches were skipped — attach them from each version\u2019s page.'}</p>
          {/* The send bar (where this is normally shown) goes away once nothing
              is left to do, so the reason a patch was skipped stays visible here. */}
          {sendError && <p className="text-sm text-status-pending" role="alert">{sendError}</p>}
          <div className="flex items-center gap-3 flex-wrap">
            {createdRows[0]?.submissionId && <Link href={`/submissions/${createdRows[0].submissionId}`}><Button>View the hack</Button></Link>}
            <Button variant="ghost" onClick={() => router.refresh()}>Done</Button>
          </div>
        </section>
      )}
    </div>
  );
}
