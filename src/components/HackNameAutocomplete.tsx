'use client';

// src/components/HackNameAutocomplete.tsx
//
// Same live-typeahead idea and the same visual language as
// EntriesSearchBox.tsx (custom terminal-icon dropdown, deliberately
// distinct from a browser's native autofill), but purpose-built for living
// inside the submit form: no <form> of its own (it's a field INSIDE
// SubmitForm's own <form> — nesting forms is invalid HTML), and selecting a
// suggestion calls back with the match instead of navigating away.
import { useState, useRef, useEffect } from 'react';
import { Terminal } from 'lucide-react';

export interface HackFamilySuggestion {
  id: string;
  name: string;
  platform: string;
  submissionId: string;
}

export function HackNameAutocomplete({
  value,
  onChange,
  onSelect,
  onBlur,
  platform,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  onSelect: (s: HackFamilySuggestion) => void;
  onBlur?: (v: string) => void;
  platform?: string;
  placeholder?: string;
  className: string;
}) {
  const [suggestions, setSuggestions] = useState<HackFamilySuggestion[]>([]);
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
        const next: HackFamilySuggestion[] = data.suggestions ?? [];
        setSuggestions(next);
        setOpen(next.length > 0);
        setActiveIndex(-1);
      } catch {
        setSuggestions([]);
      }
    }, 250);
    return () => clearTimeout(debounceRef.current);
    // Deliberately NOT re-searching just because platform changes here —
    // SubmitForm re-triggers that itself (it needs to also re-run the
    // separate near-match check), this just needs the freshest platform
    // value at the time of the NEXT keystroke, which the closure above
    // already gets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const select = (s: HackFamilySuggestion) => {
    setOpen(false);
    setSuggestions([]);
    onSelect(s);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, -1));
    } else if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      select(suggestions[activeIndex]);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <input
        required
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        onBlur={(e) => onBlur?.(e.target.value)}
        placeholder={placeholder}
        className={className}
      />
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
                select(s);
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
