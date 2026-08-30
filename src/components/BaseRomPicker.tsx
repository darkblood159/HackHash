'use client';

// src/components/BaseRomPicker.tsx
//
// Required section on the submit form (SubmitForm.tsx) — every submission
// needs a base rom reference, either an existing APPROVED one or a newly
// hashed one that starts PENDING review (the hack submission itself isn't
// blocked on that review completing, see resolveOrCreateBaseRom in
// src/lib/baseRom.ts). Two modes, switchable via the tabs below.
import { useState, useEffect, useRef } from 'react';
import { ROMProcessor } from './ROMProcessor';
import { Search, CheckCircle2, Clock, XCircle } from 'lucide-react';
import type { ROMFileInfo } from '@/types';

export interface SelectedBaseRom {
  id: string;
  name: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
}

interface BaseRomOption {
  id: string;
  name: string;
  crc32: string;
  md5: string;
  sha1: string;
}

const inputClass = "w-full px-3 py-2 rounded-md bg-bg-base border border-border text-text-primary text-sm placeholder:text-text-muted focus:border-phosphor/50";

function StatusPill({ status }: { status: SelectedBaseRom['status'] }) {
  if (status === 'APPROVED') {
    return <span className="inline-flex items-center gap-1 text-xs text-phosphor"><CheckCircle2 size={12} /> Approved</span>;
  }
  if (status === 'PENDING') {
    return <span className="inline-flex items-center gap-1 text-xs text-status-pending"><Clock size={12} /> Pending review</span>;
  }
  return <span className="inline-flex items-center gap-1 text-xs text-status-rejected"><XCircle size={12} /> Rejected</span>;
}

export function BaseRomPicker({
  platform,
  value,
  onChange,
}: {
  platform: string;
  value: SelectedBaseRom | null;
  onChange: (v: SelectedBaseRom | null) => void;
}) {
  const [mode, setMode] = useState<'select' | 'hash'>('select');
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<BaseRomOption[]>([]);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  // Bumped every time `platform` changes. The search fetch and a hash
  // submission both capture this at the moment they start and check it
  // before touching state — so a slow response that belongs to a platform
  // the user has since moved away from can never overwrite what's on
  // screen now. This is what was causing the picker to intermittently show
  // a stale/empty list, or get stuck unable to accept an upload, until a
  // full page refresh reset everything: out-of-order network responses
  // were winning the race and clobbering newer state.
  const epochRef = useRef(0);
  // Distinguishes "platform changed because the effect just ran for the
  // first time on mount" from "platform genuinely changed after mount."
  // Needed now that this component is also used in AdminEditPanel.tsx,
  // where `value` can start non-null (the submission's existing base rom)
  // — without this guard, the reset effect below would fire on the very
  // first render and immediately clear that existing selection out from
  // under the admin before they'd touched anything. SubmitForm.tsx's own
  // usage is unaffected either way, since `value` there always starts null.
  const isFirstMount = useRef(true);

  const [hashedInfo, setHashedInfo] = useState<ROMFileInfo | null>(null);
  const [needsName, setNeedsName] = useState(false);
  const [newName, setNewName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A previously selected/hashed base rom for a different platform doesn't
  // carry over — reset everything when platform changes AFTER mount. Does
  // NOT run this reset on the initial mount itself (see isFirstMount above)
  // so an existing `value` passed in from the start survives.
  useEffect(() => {
    epochRef.current += 1;
    if (isFirstMount.current) {
      isFirstMount.current = false;
      return;
    }
    onChange(null);
    setQuery('');
    setOptions([]);
    setHashedInfo(null);
    setNeedsName(false);
    setNewName('');
    setError(null);
    setSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);

  useEffect(() => {
    if (mode !== 'select' || !platform) return;
    let cancelled = false;
    const controller = new AbortController();
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ platform });
        if (query.trim()) params.set('q', query.trim());
        const res = await fetch(`/api/base-roms?${params.toString()}`, { signal: controller.signal });
        const data = await res.json();
        if (!cancelled) setOptions(data.baseRoms ?? []);
      } catch {
        if (!cancelled) setOptions([]);
      }
    }, 250);
    return () => {
      // Fires when query/platform/mode changes again before this request
      // finished, or on unmount — cancels the actual network request and
      // makes sure its response (if it lands anyway) is ignored rather
      // than applied on top of whatever the newer request already set.
      cancelled = true;
      controller.abort();
      clearTimeout(debounceRef.current);
    };
  }, [query, platform, mode]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const submitHash = async (info: ROMFileInfo, name?: string) => {
    const epoch = epochRef.current;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/base-roms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, crc32: info.crc32, md5: info.md5, sha1: info.sha1, name }),
      });
      const data = await res.json();
      // Platform changed while this was in flight — e.g. a large ROM took a
      // few seconds to hash and the submitter switched platforms before it
      // finished. The reset effect already cleared state for the new
      // platform; this response belongs to an abandoned attempt and must
      // not resurrect a selection, name prompt, or error for it.
      if (epochRef.current !== epoch) return;
      if (res.status === 422 && data.nameRequired) {
        setNeedsName(true);
        return;
      }
      if (!res.ok) {
        setError(data.error ?? 'Failed to submit base ROM');
        return;
      }
      setNeedsName(false);
      onChange({ id: data.baseRomId, name: data.name, status: data.status });
    } catch {
      if (epochRef.current === epoch) setError('Network error — please try again');
    } finally {
      if (epochRef.current === epoch) setSubmitting(false);
    }
  };

  const handleHashed = (info: ROMFileInfo) => {
    setHashedInfo(info);
    submitHash(info);
  };

  return (
    <div ref={containerRef}>
      <div className="flex gap-1 mb-3 p-1 rounded-lg bg-bg-base border border-border w-fit">
        <button
          type="button"
          onClick={() => setMode('select')}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${mode === 'select' ? 'bg-phosphor/15 text-phosphor' : 'text-text-muted hover:text-text-primary'}`}
        >
          Select existing
        </button>
        <button
          type="button"
          onClick={() => setMode('hash')}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${mode === 'hash' ? 'bg-phosphor/15 text-phosphor' : 'text-text-muted hover:text-text-primary'}`}
        >
          Hash my own copy
        </button>
      </div>

      {!platform && <p className="text-xs text-text-muted">Select a platform above first.</p>}

      {platform && mode === 'select' && (
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); onChange(null); }}
            onFocus={() => setOpen(true)}
            placeholder="Search approved base ROMs…"
            className={`${inputClass} pl-9`}
          />
          {open && options.length > 0 && (
            <div className="absolute z-20 mt-1.5 w-full rounded-lg border border-phosphor/30 bg-bg-surface shadow-lg shadow-phosphor/5 overflow-hidden max-h-64 overflow-y-auto">
              {options.map((o) => (
                <button
                  type="button"
                  key={o.id}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setQuery(o.name);
                    setOpen(false);
                    onChange({ id: o.id, name: o.name, status: 'APPROVED' });
                  }}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-elevated transition-colors"
                >
                  <span className="truncate">{o.name}</span>
                  <span className="text-[10px] font-mono text-text-muted shrink-0">{o.sha1.slice(0, 8)}…</span>
                </button>
              ))}
            </div>
          )}
          {open && query.trim().length > 0 && options.length === 0 && (
            <div className="absolute z-20 mt-1.5 w-full rounded-lg border border-border bg-bg-surface p-3 text-xs text-text-muted">
              No approved match — try "Hash my own copy" instead if you have the file.
            </div>
          )}
        </div>
      )}

      {platform && mode === 'hash' && !value && (
        <div className="space-y-3">
          <ROMProcessor
            onFileProcessed={handleHashed}
            showUseButton={false}
            label="Select or drop your base ROM file"
            hint="Hashed locally, never uploaded — just like the hack ROM above"
          />
          {submitting && <p className="text-xs text-text-muted">Checking against known base ROMs…</p>}
          {needsName && hashedInfo && (
            <div className="p-3 rounded-lg border border-border bg-bg-base space-y-2">
              <p className="text-xs text-text-secondary">
                That's not a base ROM we know about yet — what's it called? It'll be submitted for admin review, and your
                hack submission can go ahead in the meantime.
              </p>
              <div className="flex gap-2">
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Super Mario 64 (USA)"
                  className={inputClass}
                />
                <button
                  type="button"
                  disabled={!newName.trim() || submitting}
                  onClick={() => hashedInfo && submitHash(hashedInfo, newName.trim())}
                  className="px-3 py-2 rounded-md bg-phosphor/15 border border-phosphor/40 text-phosphor text-sm font-medium hover:bg-phosphor/25 transition-colors disabled:opacity-50 shrink-0"
                >
                  Submit
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-xs text-status-rejected mt-2">{error}</p>}

      {value && (
        <div className="mt-2 flex items-center justify-between gap-2 p-2.5 rounded-lg border border-phosphor/20 bg-phosphor/5">
          <span className="text-sm text-text-primary truncate">{value.name}</span>
          <div className="flex items-center gap-2 shrink-0">
            <StatusPill status={value.status} />
            <button
              type="button"
              onClick={() => { onChange(null); setQuery(''); setHashedInfo(null); setNeedsName(false); setError(null); }}
              className="text-xs text-text-muted hover:text-text-primary underline"
            >
              Change
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
