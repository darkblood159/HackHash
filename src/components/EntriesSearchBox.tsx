'use client';

// src/components/EntriesSearchBox.tsx
//
// Same look and the same eventual "submit to filter the list" behavior as
// the plain <form> input it replaces, plus a live typeahead dropdown of
// matching hack names (via GET /api/entries/autocomplete) while typing.
// Deliberately visually distinct from a browser's own native autofill
// dropdown — that one's the browser's, unstyleable by this site, and easy
// to mistake for a site feature if this one looked similar. `autoComplete
//="off"` on the input suppresses the browser's version on this field so
// the two can't visually collide in the first place.
import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Terminal } from 'lucide-react';

interface Suggestion {
  id: string;
  name: string;
  platform: string;
  submissionId: string;
}

export function EntriesSearchBox({ initialQuery, platform }: { initialQuery?: string; platform?: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initialQuery ?? '');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    clearTimeout(debounceRef.current);
    const trimmed = value.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: trimmed });
        if (platform) params.set('platform', platform);
        const res = await fetch(`/api/entries/autocomplete?${params.toString()}`);
        const data = await res.json();
        const next: Suggestion[] = data.suggestions ?? [];
        setSuggestions(next);
        setOpen(next.length > 0);
        setActiveIndex(-1);
      } catch {
        setSuggestions([]);
      }
    }, 250);
    return () => clearTimeout(debounceRef.current);
  }, [value, platform]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const submitSearch = () => {
    setOpen(false);
    const params = new URLSearchParams();
    if (value.trim()) params.set('q', value.trim());
    if (platform) params.set('platform', platform);
    router.push(`/entries${params.toString() ? `?${params.toString()}` : ''}`);
  };

  const goToSuggestion = (s: Suggestion) => {
    setOpen(false);
    router.push(`/submissions/${s.submissionId}`);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (open && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, -1));
        return;
      }
      if (e.key === 'Escape') {
        setOpen(false);
        return;
      }
      if (e.key === 'Enter' && activeIndex >= 0) {
        e.preventDefault();
        goToSuggestion(suggestions[activeIndex]);
        return;
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      submitSearch();
    }
  };

  return (
    <div ref={containerRef} className="relative mb-8">
      <form
        className="relative"
        onSubmit={(e) => {
          e.preventDefault();
          submitSearch();
        }}
      >
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
        <input
          name="q"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          placeholder="Search by name, SHA1, MD5, or CRC32…"
          className="w-full pl-10 pr-4 py-3 rounded-lg bg-bg-surface border border-border text-sm placeholder:text-text-muted focus:border-phosphor/50"
        />
      </form>

      {open && suggestions.length > 0 && (
        <div className="absolute z-20 mt-1.5 w-full rounded-lg border border-phosphor/30 bg-bg-surface shadow-lg shadow-phosphor/5 overflow-hidden">
          <div className="px-3 py-1.5 text-[10px] text-phosphor/70 uppercase tracking-widest border-b border-border-subtle bg-bg-elevated/50">
            Suggestions
          </div>
          {suggestions.map((s, i) => (
            <button
              type="button"
              key={s.id}
              onMouseDown={(e) => {
                e.preventDefault();
                goToSuggestion(s);
              }}
              onMouseEnter={() => setActiveIndex(i)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                i === activeIndex ? 'bg-phosphor/10 text-phosphor' : 'text-text-primary hover:bg-bg-elevated'
              }`}
            >
              <Terminal size={12} className="text-phosphor shrink-0" />
              <span className="truncate">{s.name}</span>
              <span className="ml-auto text-[10px] text-text-muted uppercase tracking-wider shrink-0">{s.platform}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
