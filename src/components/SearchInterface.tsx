'use client';

// src/components/SearchInterface.tsx
import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';
import { Search, Loader2 } from 'lucide-react';
import { StatusBadge } from './ui/StatusBadge';
import { PlatformBadge } from './ui/PlatformBadge';
import { TagBadge } from './ui/TagBadge';
import { formatReleaseDate } from './ReleaseDate';
import { ROMProcessor } from './ROMProcessor';
import type { ROMFileInfo } from '@/types';

interface SearchResults {
  submissions: Array<{
    id: string; hackName: string; version: string; author: string | null; platform: string;
    status: string; verificationScore: number; sha1: string; crc32: string;
    baseRom?: { id: string; name: string } | null;
    tags?: Array<{ tag: { id: string; name: string; slug: string; description: string | null } }>;
  }>;
  entries: Array<{
    id: string; submissionId: string; machineName: string; sha1: string; crc32: string; platform: string;
    submission: { author: string | null; releaseYear: number | null; releaseDate: string | null; baseRom?: { id: string; name: string } | null };
    versionCount?: number;
  }>;
}

// What field the query is matched against — 'hack' (default) checks a
// hack's own name/hash, same behavior this always had. 'baserom' checks a
// BaseRom's name/hash instead and returns whichever hacks reference
// whatever matched — same result shape either way, see /api/search's own
// searchByBaseRom for why that made the API side simpler too. 'author'
// matches the AUTHOR NAME only, across approved and unapproved hacks alike
// (see searchByAuthor in the same file for why the default mode can't).
type SearchTarget = 'hack' | 'baserom' | 'author';

export function SearchInterface() {
  const [query, setQuery] = useState('');
  const [by, setBy] = useState<SearchTarget>('hack');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);

  // `signal` is aborted by the effect below whenever the query or mode
  // changes, so a slow response for the OLD query/mode can never land after
  // (and overwrite) a newer one. Added alongside the third mode: switching
  // between Hacks / Author / Base ROM re-runs the same query against a
  // different field, which makes that overlap far easier to hit than it was
  // with typing alone. Aborted runs skip their state updates entirely.
  const search = useCallback(async (q: string, target: SearchTarget, signal?: AbortSignal) => {
    if (q.length < 2) {
      setResults(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&by=${target}`, { signal });
      const data = await res.json();
      if (!signal?.aborted) setResults(data);
    } catch {
      // Aborted (superseded by a newer search) or a network failure — either
      // way, don't leave results from a search that didn't complete.
      if (!signal?.aborted) setResults(null);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => search(query, by, controller.signal), 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, by, search]);

  // A dropped ROM file only makes sense as "does anyone have a hack for
  // THIS" — a base-rom lookup — not a check on whether the file itself is
  // already a submitted hack (that's what Verify is for, from a submission
  // you already have open). Switches the mode pill to match, so the UI
  // stays honest about what's actually happening. Just updates state here
  // rather than also calling search() directly — the effect above already
  // reacts to query/by changing, and firing both would mean two identical
  // requests for every drop; the extra 300ms on top of however long
  // hashing itself just took isn't worth avoiding twice the API calls for.
  const handleFileHashed = useCallback((info: ROMFileInfo) => {
    setBy('baserom');
    setQuery(info.sha1);
  }, []);

  return (
    <div>
      <div className="flex gap-1.5 mb-3">
        <button
          type="button"
          onClick={() => setBy('hack')}
          className={clsx(
            'px-3 py-1.5 rounded-full text-xs font-medium border transition-colors',
            by === 'hack'
              ? 'bg-phosphor/15 border-phosphor/40 text-phosphor'
              : 'bg-bg-surface border-border text-text-secondary hover:border-phosphor/30'
          )}
        >
          Hacks
        </button>
        <button
          type="button"
          onClick={() => setBy('baserom')}
          className={clsx(
            'px-3 py-1.5 rounded-full text-xs font-medium border transition-colors',
            by === 'baserom'
              ? 'bg-phosphor/15 border-phosphor/40 text-phosphor'
              : 'bg-bg-surface border-border text-text-secondary hover:border-phosphor/30'
          )}
        >
          Base ROM
        </button>
        <button
          type="button"
          onClick={() => setBy('author')}
          className={clsx(
            'px-3 py-1.5 rounded-full text-xs font-medium border transition-colors',
            by === 'author'
              ? 'bg-phosphor/15 border-phosphor/40 text-phosphor'
              : 'bg-bg-surface border-border text-text-secondary hover:border-phosphor/30'
          )}
        >
          Author
        </button>
      </div>

      <div className="relative mb-4">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={by === 'baserom' ? 'Type a base ROM name or paste its hash…' : by === 'author' ? 'Type an author name…' : 'Type a hack name or paste a hash…'}
          className="w-full pl-10 pr-10 py-3 rounded-lg bg-bg-surface border border-border text-sm font-mono placeholder:font-sans placeholder:text-text-muted focus:border-phosphor/50"
        />
        {loading && <Loader2 size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-phosphor animate-spin" />}
      </div>

      <div className="flex items-center gap-3 mb-6">
        <div className="h-px flex-1 bg-border" />
        <span className="text-[10px] text-text-muted uppercase tracking-widest">or</span>
        <div className="h-px flex-1 bg-border" />
      </div>
      <div className="mb-8">
        <ROMProcessor
          onFileProcessed={handleFileHashed}
          showUseButton={false}
          label="Drop a ROM to search by its hash"
          hint="Hashed locally and never uploaded — only the hash is used to search"
        />
      </div>

      {results && (
        <div className="space-y-8">
          {results.submissions.length > 0 && (
            <div>
              <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
                Submissions ({results.submissions.length})
              </h2>
              <div className="space-y-2">
                {results.submissions.map((s) => (
                  <Link key={s.id} href={`/submissions/${s.id}`} className="flex items-center justify-between p-3 rounded-lg border border-border bg-bg-surface hover:border-phosphor/30 transition-colors">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium text-text-primary">{s.hackName} <span className="text-text-muted font-normal">v{s.version}</span></p>
                        <PlatformBadge platform={s.platform} size="sm" />
                      </div>
                      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                        <p className="text-xs text-text-muted">
                          {s.author && <>by {s.author} · </>}
                          {s.baseRom && <>base ROM: {s.baseRom.name} · </>}
                          <span className="font-mono">{s.sha1.slice(0, 12)}…</span>
                        </p>
                        {s.tags?.slice(0, 3).map((t) => (
                          <TagBadge key={t.tag.id} name={t.tag.name} slug={t.tag.slug} href={`/submissions?tag=${t.tag.slug}`} description={t.tag.description} />
                        ))}
                      </div>
                    </div>
                    <StatusBadge status={s.status} size="sm" />
                  </Link>
                ))}
              </div>
            </div>
          )}

          {results.entries.length > 0 && (
            <div>
              <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
                Database entries ({results.entries.length})
              </h2>
              <div className="space-y-2">
                {results.entries.map((e) => (
                  <Link key={e.id} href={`/submissions/${e.submissionId}`} className="flex items-center justify-between p-3 rounded-lg border border-border bg-bg-surface hover:border-phosphor/30 transition-colors">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-text-primary">{e.machineName}</p>
                        <PlatformBadge platform={e.platform} size="sm" />
                        {e.versionCount && e.versionCount > 1 && (
                          <span className="text-[10px] text-text-muted uppercase tracking-wider px-1.5 py-0.5 rounded bg-bg-elevated">
                            {e.versionCount} versions
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-text-muted">
                        {e.submission.author && <>by {e.submission.author} </>}
                        {(e.submission.releaseDate || e.submission.releaseYear) && (
                          <>({e.submission.releaseDate ? formatReleaseDate(e.submission.releaseDate) : e.submission.releaseYear}) </>
                        )}
                        {e.submission.baseRom && <>· base ROM: {e.submission.baseRom.name} </>}
                        · <span className="font-mono">{e.sha1.slice(0, 12)}…</span>
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {results.submissions.length === 0 && results.entries.length === 0 && (
            <p className="text-text-muted text-sm text-center py-12">
              {by === 'baserom'
                ? `No hacks found using a base ROM matching "${query}".`
                : by === 'author'
                  ? `No hacks found by an author matching "${query}".`
                  : `No results for "${query}".`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
