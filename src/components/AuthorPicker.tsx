'use client';

// src/components/AuthorPicker.tsx
//
// Picks (or proposes) the person/team credited with a hack. Modeled
// directly on FranchisePicker (see that file's own comment for the full
// reasoning) — an existing author is chosen from a searchable list, and a
// new one is only offered when nothing already listed matches. OPTIONAL by
// design (value: null is a normal, valid state — see the schema comment on
// Submission.authorId), so there's an explicit "Remove" and the parent
// decides what null means.
//
// Search shows APPROVED and still-PENDING authors (pending ones tagged),
// plus near-misses ("similar") within a small edit distance. See GET
// /api/authors and searchAuthors() in src/lib/author.ts.
//
// Built with the same stale-response guard FranchisePicker has from the
// start (cancelled flag + AbortController on the debounced search, epoch
// ref on the create call) so an out-of-order response can never overwrite a
// newer one.

import { useState, useEffect, useRef } from 'react';
import { Search, Loader2, Plus, X } from 'lucide-react';

export interface SelectedAuthor {
  id: string;
  name: string;
  status: 'PENDING' | 'APPROVED';
}

interface AuthorHit extends SelectedAuthor {
  exact: boolean;
  similar: boolean;
}

interface AuthorPickerProps {
  value: SelectedAuthor | null;
  onChange: (value: SelectedAuthor | null) => void;
  // False turns this into a pure chooser (no "Add new" row) — used by the
  // admin merge tool, where creating an author mid-merge makes no sense.
  allowCreate?: boolean;
  // Hides one author from results (the merge tool excludes the one being merged away).
  excludeId?: string;
  placeholder?: string;
  // Pre-fills the search box on first render, while value is still null.
  // Used for a submission that already has a free-text `author` string but
  // no authorId yet (every submission from before this system existed) —
  // seeds the search with that existing text so whoever's editing can see
  // right away whether a matching Author row already exists, rather than
  // the picker opening on an empty box that looks like nothing is on
  // record at all. Purely a starting point — normal typing/clearing works
  // as usual once rendered.
  initialQuery?: string;
}

export function AuthorPicker({ value, onChange, allowCreate = true, excludeId, placeholder, initialQuery }: AuthorPickerProps) {
  const [changing, setChanging] = useState(false);
  const [query, setQuery] = useState(initialQuery ?? '');
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<AuthorHit[]>([]);
  const [hasExactMatch, setHasExactMatch] = useState(false);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Bumped on cancel/unmount so a create call that resolves late is ignored.
  const createEpochRef = useRef(0);

  const searching = !value || changing;
  const trimmed = query.trim();

  // Close the dropdown on any click outside this component.
  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, []);

  useEffect(() => () => { createEpochRef.current += 1; }, []);

  // Debounced search. `cancelled` + abort make sure only the response for
  // the CURRENT query/open state is ever applied.
  useEffect(() => {
    if (!open || !searching) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ includePending: '1' });
        if (trimmed) params.set('q', trimmed);
        if (excludeId) params.set('excludeId', excludeId);
        const res = await fetch(`/api/authors?${params.toString()}`, { signal: controller.signal });
        if (!res.ok) throw new Error('search failed');
        const data = await res.json();
        if (cancelled) return;
        setHits(Array.isArray(data.authors) ? data.authors : []);
        setHasExactMatch(!!data.exactMatch);
      } catch {
        // Aborted (a newer search superseded this one) or a network blip —
        // either way there's nothing useful to show from this response.
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, trimmed ? 200 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, open, searching, excludeId]);

  function pick(a: SelectedAuthor) {
    createEpochRef.current += 1;
    setNotice(null);
    setError(null);
    setQuery('');
    setOpen(false);
    setChanging(false);
    onChange({ id: a.id, name: a.name, status: a.status });
  }

  async function createNew() {
    if (!trimmed || creating) return;
    const epoch = ++createEpochRef.current;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/authors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json();
      if (epoch !== createEpochRef.current) return;
      if (!res.ok) {
        setError(data.error ?? 'Could not add that author');
        return;
      }
      // The server resolves against existing names, so this can hand back
      // an author that already existed under slightly different spelling —
      // say so, rather than silently showing a different name than typed.
      setNotice(
        data.isNew
          ? null
          : `"${data.name}" already exists, so it was used instead of creating a duplicate.`
      );
      setQuery('');
      setOpen(false);
      setChanging(false);
      onChange({ id: data.authorId, name: data.name, status: data.status });
    } catch {
      if (epoch === createEpochRef.current) setError('Network error — please try again');
    } finally {
      if (epoch === createEpochRef.current) setCreating(false);
    }
  }

  function cancelChange() {
    createEpochRef.current += 1;
    setChanging(false);
    setQuery('');
    setOpen(false);
    setError(null);
  }

  // ── Selected state ──
  if (!searching && value) {
    return (
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-bg-base border border-border text-xs text-text-primary">
            <span className="truncate">{value.name}</span>
            {value.status === 'PENDING' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-pending-bg text-status-pending">pending review</span>
            )}
          </span>
          <button type="button" onClick={() => { setChanging(true); setNotice(null); }} className="text-xs text-phosphor hover:underline">
            Change
          </button>
          <button
            type="button"
            onClick={() => { setNotice(null); onChange(null); }}
            className="text-xs text-text-muted hover:text-status-rejected hover:underline"
          >
            Remove
          </button>
        </div>
        {notice && <p className="mt-1 text-xs text-text-secondary">{notice}</p>}
      </div>
    );
  }

  // ── Search state ──
  const showCreateRow = allowCreate && !!trimmed && !hasExactMatch && !loading;
  const nearMatchCount = hits.length;

  return (
    <div ref={wrapperRef} className="relative">
      <div className="relative">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
        <input
          type="text"
          value={query}
          disabled={creating}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setError(null); }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder ?? 'Search authors (e.g. RomHacker99)…'}
          className="w-full pl-7 pr-8 py-2 rounded-md bg-bg-surface border border-border text-text-primary text-sm placeholder:text-text-muted focus:border-phosphor/50 transition-colors disabled:opacity-60"
          autoComplete="off"
        />
        {(loading || creating) && (
          <Loader2 size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-text-muted" />
        )}
      </div>

      {open && (
        <div className="absolute z-10 mt-1 w-full max-h-64 overflow-y-auto rounded-md border border-border bg-bg-surface shadow-lg">
          {hits.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => pick(h)}
              className="w-full text-left px-3 py-2 text-xs hover:bg-phosphor/10 flex items-center justify-between gap-2"
            >
              <span className="text-text-primary truncate">{h.name}</span>
              <span className="flex items-center gap-1.5 shrink-0">
                {h.similar && <span className="text-[10px] text-text-muted italic">similar</span>}
                {h.status === 'PENDING' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-pending-bg text-status-pending">pending review</span>
                )}
              </span>
            </button>
          ))}

          {!loading && hits.length === 0 && (
            <p className="px-3 py-2 text-xs text-text-muted">
              {trimmed ? 'No authors match that.' : 'No authors yet.'}
            </p>
          )}

          {showCreateRow && (
            <div className="border-t border-border">
              {nearMatchCount > 0 && (
                <p className="px-3 pt-2 text-[11px] text-status-pending">
                  Something above may be the same person — pick it instead of adding a duplicate.
                </p>
              )}
              <button
                type="button"
                onClick={createNew}
                className="w-full text-left px-3 py-2 text-xs hover:bg-phosphor/10 flex items-center gap-1.5 text-phosphor"
              >
                <Plus size={12} /> Add &ldquo;{trimmed}&rdquo; as a new author
              </button>
              <p className="px-3 pb-2 text-[11px] text-text-muted">New authors are reviewed by an admin. Your hack can use it right away.</p>
            </div>
          )}
        </div>
      )}

      {error && <p className="mt-1 text-xs text-status-rejected">{error}</p>}
      {changing && value && (
        <button type="button" onClick={cancelChange} className="mt-1 inline-flex items-center gap-1 text-xs text-text-muted hover:underline">
          <X size={10} /> Keep &ldquo;{value.name}&rdquo;
        </button>
      )}
    </div>
  );
}
