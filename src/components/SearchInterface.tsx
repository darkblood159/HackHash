'use client';

// src/components/SearchInterface.tsx
import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Search, Loader2 } from 'lucide-react';
import { StatusBadge } from './ui/StatusBadge';
import { PlatformBadge } from './ui/PlatformBadge';
import { TagBadge } from './ui/TagBadge';
import { formatReleaseDate } from './ReleaseDate';

interface SearchResults {
  submissions: Array<{
    id: string; hackName: string; version: string; author: string | null; platform: string;
    status: string; verificationScore: number; sha1: string; crc32: string;
    tags?: Array<{ tag: { id: string; name: string; slug: string; description: string | null } }>;
  }>;
  entries: Array<{
    id: string; submissionId: string; machineName: string; sha1: string; crc32: string; platform: string;
    submission: { author: string | null; releaseYear: number | null; releaseDate: string | null };
    versionCount?: number;
  }>;
}

export function SearchInterface() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);

  const search = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults(null);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setResults(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => search(query), 300);
    return () => clearTimeout(timer);
  }, [query, search]);

  return (
    <div>
      <div className="relative mb-8">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type a hack name or paste a hash…"
          className="w-full pl-10 pr-10 py-3 rounded-lg bg-bg-surface border border-border text-sm font-mono placeholder:font-sans placeholder:text-text-muted focus:border-phosphor/50"
        />
        {loading && <Loader2 size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-phosphor animate-spin" />}
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
                        <p className="text-xs text-text-muted">{s.author && <>by {s.author} · </>}<span className="font-mono">{s.sha1.slice(0, 12)}…</span></p>
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
                        · <span className="font-mono">{e.sha1.slice(0, 12)}…</span>
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {results.submissions.length === 0 && results.entries.length === 0 && (
            <p className="text-text-muted text-sm text-center py-12">No results for "{query}".</p>
          )}
        </div>
      )}
    </div>
  );
}
