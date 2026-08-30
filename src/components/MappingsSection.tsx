'use client';

// src/components/MappingsSection.tsx
import React, { useState } from 'react';
import { ChevronDown, ChevronUp, Link2, AlertTriangle } from 'lucide-react';
import { stripMappingValue, isMappingFieldKey } from '@/lib/mappingFields';

export interface MappingValues {
  epicGamesId?: string;
  gogId?: string;
  giantBombId?: string;
  igdbId?: string;
  launchboxId?: string;
  retroAchievementsId?: string;
  screenScraperId?: string;
  steamId?: string;
  steamGridDBId?: string;
  theGamesDBId?: string;
  wikipediaUrl?: string;
}

interface MappingField {
  key: keyof MappingValues;
  label: string;
  placeholder: string;
  hint?: string;
  // warn: return a warning string if the value looks wrong
  warn?: (v: string) => string | null;
}

const FIELDS: MappingField[] = [
  {
    key: 'igdbId',
    label: 'IGDB',
    placeholder: '218072',
    hint: 'Numeric game ID only — not the URL slug',
    // No stripper for this field in the shared module either — igdb.com
    // URLs use slugs, not numeric IDs, so stripping the URL would give the
    // wrong value. Users must enter the numeric ID directly.
    warn: (v) => {
      if (v.startsWith('http') || v.includes('/')) {
        return 'Enter the numeric ID (e.g. 218072), not the URL. The IGDB URL contains a slug, not the numeric ID — find the numeric ID on igdb.com or via the IGDB API.';
      }
      if (v && !/^\d+$/.test(v)) {
        return 'IGDB IDs are numeric (e.g. 218072). Is this the right value?';
      }
      return null;
    },
  },
  {
    key: 'theGamesDBId',
    label: 'TheGamesDB',
    placeholder: '74085 or https://thegamesdb.net/game.php?id=74085',
  },
  {
    key: 'launchboxId',
    label: 'LaunchBox',
    placeholder: '157780 or https://gamesdb.launchbox-app.com/games/dbid/157780',
  },
  {
    key: 'steamGridDBId',
    label: 'SteamGridDB',
    placeholder: '5372419 or https://www.steamgriddb.com/game/5372419',
  },
  {
    key: 'retroAchievementsId',
    label: 'RetroAchievements',
    placeholder: '12345 or https://retroachievements.org/game/12345',
  },
  {
    key: 'steamId',
    label: 'Steam',
    placeholder: '1234560 or https://store.steampowered.com/app/1234560',
  },
  {
    key: 'gogId',
    label: 'GOG.com',
    placeholder: 'gog-slug or https://www.gog.com/game/game-name',
  },
  {
    key: 'giantBombId',
    label: 'Giant Bomb',
    placeholder: '44054 or https://www.giantbomb.com/games/3030-44054/',
  },
  {
    key: 'screenScraperId',
    label: 'ScreenScraper',
    placeholder: '12345',
  },
  {
    key: 'epicGamesId',
    label: 'Epic Games',
    placeholder: 'game-slug or store URL',
  },
  {
    key: 'wikipediaUrl',
    label: 'Wikipedia',
    placeholder: 'https://en.wikipedia.org/wiki/Game_Title',
  },
];

interface MappingsSectionProps {
  values: MappingValues;
  onChange: (values: MappingValues) => void;
}

const inputClass =
  'w-full px-2.5 py-1.5 rounded-md bg-bg-base border border-border text-text-primary text-xs placeholder:text-text-muted focus:border-phosphor/50 font-mono';

export function MappingsSection({ values, onChange }: MappingsSectionProps) {
  const [open, setOpen] = useState(false);
  const [warnings, setWarnings] = useState<Partial<Record<keyof MappingValues, string>>>({});

  const filledCount = FIELDS.filter((f) => values[f.key]).length;

  const set = (field: MappingField, raw: string) => {
    const trimmed = raw.trim();
    // Delegates to the SAME stripper used server-side (submit, admin edit,
    // change-request, and Hasheous auto-pull all already went through
    // stripMappingValue) — this component used to keep its own separate
    // copy of these regexes, which drifted out of sync with the server-side
    // versions at least once (found live, Aug 14: a fixed LaunchBox URL
    // shape was recognized by the server but not here, so a value that
    // happened to reach the server pre-stripped some other way could behave
    // differently than one typed directly into this form). One shared
    // implementation now — this can't happen again.
    const stripped = isMappingFieldKey(field.key) ? stripMappingValue(field.key, trimmed) : trimmed;
    const warning = field.warn ? field.warn(stripped) : null;
    setWarnings((w) => ({ ...w, [field.key]: warning ?? undefined }));
    onChange({ ...values, [field.key]: stripped || undefined });
  };

  return (
    <div className={`rounded-lg border-2 overflow-hidden transition-colors ${
      filledCount > 0 ? 'border-phosphor/40 bg-phosphor/5' : 'border-border bg-bg-surface'
    }`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-3">
          <div className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${
            filledCount > 0 ? 'bg-phosphor/20' : 'bg-bg-elevated'
          }`}>
            <Link2 size={15} className={filledCount > 0 ? 'text-phosphor' : 'text-text-muted'} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-text-primary">Game database links</span>
              {filledCount > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-phosphor/20 text-phosphor font-medium">
                  {filledCount} linked
                </span>
              )}
            </div>
            <p className="text-[10px] text-text-muted mt-0.5">
              Link to IGDB, TheGamesDB, etc. to help other platforms import metadata
            </p>
          </div>
        </div>
        {open ? <ChevronUp size={14} className="text-text-muted shrink-0" /> : <ChevronDown size={14} className="text-text-muted shrink-0" />}
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-border">
          <p className="text-xs text-text-muted py-2">
            None of these are required. IGDB and TheGamesDB IDs are most useful for syncing with Hasheous.
            Paste a URL or just the ID — we'll extract the ID automatically (except IGDB, which needs the numeric ID directly).
          </p>
          <div className="grid sm:grid-cols-2 gap-3">
            {FIELDS.map((field) => (
              <div key={field.key}>
                <label className="block text-[10px] text-text-muted uppercase tracking-wider mb-1 flex items-center gap-1.5">
                  {field.label}
                  {field.hint && <span className="normal-case tracking-normal text-text-muted/70">— {field.hint}</span>}
                </label>
                <input
                  className={`${inputClass} ${warnings[field.key] ? 'border-status-pending/60' : ''}`}
                  value={values[field.key] ?? ''}
                  placeholder={field.placeholder}
                  onChange={(e) => set(field, e.target.value)}
                />
                {warnings[field.key] && (
                  <p className="flex items-start gap-1 mt-1 text-[10px] text-status-pending leading-tight">
                    <AlertTriangle size={9} className="shrink-0 mt-0.5" />
                    {warnings[field.key]}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
