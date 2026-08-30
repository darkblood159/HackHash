'use client';

// src/components/FamilyPicker.tsx
//
// Search-and-select control for moving a submission into a DIFFERENT
// existing hack family (or detaching it), used inside the approval menu
// (AdminActions.tsx) so an admin can correct a wrong auto-join, or attach
// an ungrouped submission, before approving it. Same chip-plus-"Change"
// interaction language as BaseRomPicker.tsx once something's selected,
// since that's already a familiar pattern on this page.
//
// Built with the debounce-cancellation guard from day one (epoch ref +
// AbortController)
import { useState, useEffect, useRef } from 'react';
import { Search } from 'lucide-react';

export interface SelectedFamily {
  id: string;
  name: string;
}

interface FamilyOption extends SelectedFamily {
  versionCount: number;
}

export function FamilyPicker({
  platform,
  excludeFamilyId,
  value,
  onChange,
}: {
  platform: string;
  excludeFamilyId?: string;
  value: SelectedFamily | null;
  onChange: (v: SelectedFamily | null) => void;
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<FamilyOption[]>([]);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  // Bumped whenever the search UI is (re)opened, so a slow response from a
  // search that's since been abandoned (closed, or superseded by a newer
  // query) can never land on top of what's currently on screen.
  const epochRef = useRef(0);

  useEffect(() => {
    if (!searching || !platform) return;
    let cancelled = false;
    const controller = new AbortController();
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ platform });
        if (query.trim()) params.set('q', query.trim());
        if (excludeFamilyId) params.set('excludeFamilyId', excludeFamilyId);
        const res = await fetch(`/api/admin/hack-families/search?${params.toString()}`, { signal: controller.signal });
        const data = await res.json();
        if (!cancelled) setOptions(data.families ?? []);
      } catch {
        if (!cancelled) setOptions([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(debounceRef.current);
    };
  }, [query, platform, searching, excludeFamilyId]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const startSearching = () => {
    epochRef.current += 1;
    setSearching(true);
    setOpen(true);
    setQuery('');
    setOptions([]);
  };

  const select = (f: FamilyOption) => {
    onChange({ id: f.id, name: f.name });
    setSearching(false);
    setOpen(false);
  };

  if (!searching) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        {value ? (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-bg-base border border-border text-xs text-text-primary">
            {value.name}
          </span>
        ) : (
          <span className="text-xs text-text-muted italic">No family (standalone)</span>
        )}
        <button type="button" onClick={startSearching} className="text-xs text-phosphor hover:underline">
          Change
        </button>
        {value && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-xs text-text-muted hover:text-status-rejected hover:underline"
          >
            Remove from family
          </button>
        )}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder="Search families on this platform…"
          className="w-full pl-7 pr-3 py-1.5 rounded-md bg-bg-base border border-border text-xs focus:border-phosphor/50"
        />
      </div>
      {open && (
        <div className="absolute z-10 mt-1 w-full max-h-56 overflow-y-auto rounded-md border border-border bg-bg-surface shadow-lg">
          {options.length === 0 ? (
            <p className="px-3 py-2 text-xs text-text-muted">
              {query.trim() ? 'No matching families' : 'No other families on this platform yet'}
            </p>
          ) : (
            options.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => select(f)}
                className="w-full text-left px-3 py-2 text-xs hover:bg-phosphor/10 flex items-center justify-between gap-2"
              >
                <span className="text-text-primary truncate">{f.name}</span>
                <span className="text-text-muted shrink-0">{f.versionCount} version{f.versionCount === 1 ? '' : 's'}</span>
              </button>
            ))
          )}
        </div>
      )}
      <button
        type="button"
        onClick={() => { setSearching(false); setOpen(false); }}
        className="mt-1 text-xs text-text-muted hover:underline"
      >
        Cancel
      </button>
    </div>
  );
}
