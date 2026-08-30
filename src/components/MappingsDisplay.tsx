// src/components/MappingsDisplay.tsx
// Server-Component-safe read-only display of game database mappings.
import React from 'react';
import { Link2, ExternalLink, Clock, CheckCircle2, AlertTriangle } from 'lucide-react';
import { isMappingFieldKey, stripMappingValue } from '@/lib/mappingFields';
import { getIGDBGameUrl } from '@/lib/hasheous';
import { formatDistanceToNow } from 'date-fns';

// Used only to build the /games/details/{id}-{slug} URL shape for LaunchBox
// — see the launchboxId override in the render loop below for why this is
// needed instead of trusting Hasheous's own computed link for this source.
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

interface MappingValues {
  epicGamesId?: string | null;
  gogId?: string | null;
  giantBombId?: string | null;
  igdbId?: string | null;
  igdbSlug?: string | null;
  launchboxId?: string | null;
  retroAchievementsId?: string | null;
  screenScraperId?: string | null;
  steamId?: string | null;
  steamGridDBId?: string | null;
  theGamesDBId?: string | null;
  wikipediaUrl?: string | null;
  canonicalName?: string | null;
  canonicalDescription?: string | null;
  canonicalReleaseDate?: Date | string | null;
  // Ready-made links Hasheous computed server-side, keyed by its own source
  // name (e.g. "GiantBomb") — see GameMapping.hasheousLinks. Preferred over
  // this component's own url() templates below when present, since those
  // templates have drifted from Hasheous's real convention at least once
  // before (GiantBomb needs a "3030-" prefix ours didn't add — confirmed
  // against Hasheous's own LinkBuilder source, not guessed).
  hasheousLinks?: Record<string, string> | null;
  // Push verification — see src/lib/hasheousSync.ts for how these transition
  hasheousPushStatus?: string | null; // 'pending' | 'confirmed' | 'not_reflected'
  hasheousPushedAt?: Date | string | null;
  hasheousPushVerifiedAt?: Date | string | null;
}

const FIELD_CONFIG: {
  key: keyof MappingValues;
  label: string;
  // Hasheous's own MetadataSources enum string for this field — used to look
  // up a ready-made link in hasheousLinks before falling back to url() below.
  source: string;
  url?: (v: string) => string;
  color: string;
}[] = [
  {
    // No `url` here — IGDB is special-cased in the render below, since it
    // needs a resolved slug, not the raw numeric ID, to link anywhere
    // useful. hasheousLinks.IGDB / igdbSlug cover this now — see render.
    key: 'igdbId', label: 'IGDB', source: 'IGDB',
    color: 'text-blue-400',
  },
  {
    key: 'theGamesDBId', label: 'TheGamesDB', source: 'TheGamesDb',
    url: (v) => `https://thegamesdb.net/game.php?id=${v}`,
    color: 'text-yellow-400',
  },
  {
    // No `url` here — like IGDB, this source is special-cased in the
    // render below rather than using a simple template. Hasheous's own
    // .../games/dbid/{id} convention (which a template here would just
    // repeat) doesn't actually resolve on LaunchBox's real site; see the
    // launchboxId branch in the render loop for the working URL shape.
    key: 'launchboxId', label: 'LaunchBox', source: 'LaunchBox',
    color: 'text-orange-400',
  },
  {
    key: 'steamGridDBId', label: 'SteamGridDB', source: 'SteamGridDb',
    url: (v) => `https://www.steamgriddb.com/game/${v}`,
    color: 'text-blue-300',
  },
  {
    key: 'retroAchievementsId', label: 'RetroAchievements', source: 'RetroAchievements',
    url: (v) => `https://retroachievements.org/game/${v}`,
    color: 'text-red-400',
  },
  {
    key: 'steamId', label: 'Steam', source: 'Steam',
    url: (v) => `https://store.steampowered.com/app/${v}`,
    color: 'text-blue-400',
  },
  {
    key: 'gogId', label: 'GOG.com', source: 'GOG',
    url: (v) => `https://www.gog.com/game/${v}`,
    color: 'text-purple-400',
  },
  {
    // The old template here (giantbomb.com/game/{id}, no prefix) was WRONG —
    // confirmed against Hasheous's own LinkBuilder, the real convention is
    // /games/3030-{id}/ (3030 = GiantBomb's internal "Game" object-type
    // prefix). Kept as a fallback for ids entered before hasheousLinks
    // existed, but now corrected to match reality either way.
    key: 'giantBombId', label: 'Giant Bomb', source: 'GiantBomb',
    url: (v) => `https://www.giantbomb.com/games/3030-${v}/`,
    color: 'text-yellow-500',
  },
  {
    key: 'screenScraperId', label: 'ScreenScraper', source: 'ScreenScraper',
    url: (v) => `https://www.screenscraper.fr/gameinfos.php?gameid=${v}`,
    color: 'text-green-400',
  },
  {
    key: 'epicGamesId', label: 'Epic Games', source: 'EpicGameStore',
    url: (v) => v.startsWith('http') ? v : `https://www.epicgames.com/store/p/${v}`,
    color: 'text-text-secondary',
  },
  {
    key: 'wikipediaUrl', label: 'Wikipedia', source: 'Wikipedia',
    url: (v) => v,
    color: 'text-text-secondary',
  },
];

export function MappingsDisplay({ mapping, hackName }: { mapping: MappingValues; hackName?: string | null }) {
  // Strip (and clear any corrupted "[object Object]"-type garbage) BEFORE
  // filtering, not after — otherwise a corrupted value survives the filter
  // on its raw truthy value and renders as a blank row instead of being
  // excluded like a genuinely-absent field would be.
  const displayItems = FIELD_CONFIG
    .map((field) => {
      const rawValue = String(mapping[field.key] ?? '');
      const value = isMappingFieldKey(field.key) ? stripMappingValue(field.key, rawValue) : rawValue;
      return { ...field, value };
    })
    .filter((f) => f.value);

  if (displayItems.length === 0 && !mapping.canonicalName && !mapping.canonicalDescription && !mapping.canonicalReleaseDate) return null;

  const pushStatus = mapping.hasheousPushStatus;

  return (
    <div className="rounded-lg border-2 border-phosphor/30 bg-phosphor/5 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-phosphor/20">
        <div className="w-8 h-8 rounded-md bg-phosphor/20 flex items-center justify-center shrink-0">
          <Link2 size={15} className="text-phosphor" />
        </div>
        <div>
          <span className="text-sm font-semibold text-text-primary">Game database links</span>
          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-phosphor/20 text-phosphor font-medium">
            {displayItems.length} linked
          </span>
        </div>
      </div>

      {pushStatus && (
        <div className="px-4 py-2 border-b border-phosphor/20 text-xs flex items-center gap-1.5">
          {pushStatus === 'confirmed' && (
            <span className="text-status-approved flex items-center gap-1.5">
              <CheckCircle2 size={13} />
              Confirmed on Hasheous
              {mapping.hasheousPushVerifiedAt && ` ${formatDistanceToNow(new Date(mapping.hasheousPushVerifiedAt), { addSuffix: true })}`}
            </span>
          )}
          {pushStatus === 'pending' && (
            <span
              className="text-status-pending flex items-center gap-1.5"
              title="Hasheous treats a push as a community vote, not a direct edit. It applies immediately if this was previously unmatched there — otherwise it needs 2 more people to independently agree before it can override an existing match."
            >
              <Clock size={13} />
              Vote submitted to Hasheous
              {mapping.hasheousPushedAt && ` ${formatDistanceToNow(new Date(mapping.hasheousPushedAt), { addSuffix: true })}`}
              , not yet confirmed
            </span>
          )}
          {pushStatus === 'not_reflected' && (
            <span
              className="text-status-rejected flex items-center gap-1.5"
              title="Most likely: Hasheous already had this mapped and our vote alone can't override it — that needs 2 more people to independently agree there, which we can't make happen automatically. Less likely: Hasheous rejected the id outright (check the push log for a per-source reason)."
            >
              <AlertTriangle size={13} />
              Not confirmed 48h+ after the vote — likely needs more community agreement
              {mapping.hasheousPushedAt && ` (pushed ${formatDistanceToNow(new Date(mapping.hasheousPushedAt), { addSuffix: true })})`}
            </span>
          )}
        </div>
      )}

      <div className="px-4 py-3">
        {/* Canonical metadata */}
        {(mapping.canonicalName || mapping.canonicalDescription || mapping.canonicalReleaseDate) && (
          <div className="mb-3 pb-3 border-b border-phosphor/20">
            {mapping.canonicalName && (
              <p className="text-xs text-text-muted">
                Canonical name:{' '}
                <span className="text-text-primary font-semibold">{mapping.canonicalName}</span>
              </p>
            )}
            {mapping.canonicalReleaseDate && (
              <p className="text-xs text-text-muted mt-0.5">
                Release date:{' '}
                <span className="text-text-primary">
                  {new Date(mapping.canonicalReleaseDate).toLocaleDateString()}
                </span>
              </p>
            )}
            {mapping.canonicalDescription && (
              <p className="text-xs text-text-muted mt-1 line-clamp-3">
                {mapping.canonicalDescription}
              </p>
            )}
          </div>
        )}

        <div className="grid sm:grid-cols-2 gap-2">
          {displayItems.map(({ key, label, url, color, value, source }) => {
            // Hasheous's own server-computed link, when we have one, wins
            // over this component's own url() template — see hasheousLinks'
            // schema comment for why (at least one of these templates had
            // drifted from the real convention).
            const hasheousLink = mapping.hasheousLinks?.[source];
            let href: string | null = hasheousLink ?? (url ? url(value) : null);
            let displayValue = value;

            if (key === 'igdbId' && !hasheousLink) {
              if (mapping.igdbSlug) {
                href = getIGDBGameUrl(mapping.igdbSlug);
              } else {
                // No slug resolved yet — a link built from the numeric ID
                // alone redirects to IGDB's search page instead of the game,
                // so don't render one. Falls back to a plain, informative label.
                href = null;
                displayValue = `${value} (no direct link yet)`;
              }
            } else if (key === 'launchboxId') {
              // OVERRIDES whatever href was set above — both the
              // hasheousLinks value AND this field's own url() template
              // point at .../games/dbid/{id}, which is Hasheous's own
              // hardcoded convention for this source (confirmed against
              // their LinkBuilder source) but does NOT actually resolve on
              // LaunchBox's real site (confirmed live, Aug 14 — clicking it
              // produced a dead/mangled link). The shape that actually
              // works is .../games/details/{id}-{slug}. LaunchBox's routing
              // appears to key off the numeric id and tolerate an
              // approximate slug (common for this kind of URL — the id is
              // authoritative, the slug is cosmetic), so this doesn't need
              // to exactly match LaunchBox's own listing title, just be
              // reasonably close. Built from canonicalName (Hasheous's own
              // resolved title) first, falling back to the submission's own
              // hackName if that's not available yet.
              const slug = slugify(mapping.canonicalName || hackName || '');
              href = `https://gamesdb.launchbox-app.com/games/details/${value}${slug ? `-${slug}` : ''}`;
            }

            return (
              <div key={key} className="flex items-center gap-2 min-w-0 group">
                <span className="text-[10px] text-text-muted uppercase tracking-wider shrink-0 w-32">
                  {label}
                </span>
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className={`text-xs font-mono ${color} hover:underline flex items-center gap-1 truncate`}
                  >
                    {displayValue}
                    <ExternalLink size={9} className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                  </a>
                ) : (
                  <span className={`text-xs font-mono ${color} truncate`} title={key === 'igdbId' ? 'IGDB numeric ID — the direct link needs a slug IGDB only exposes separately; this gets fetched automatically on the next background sync, or use "Force re-check" below to fetch it now' : undefined}>
                    {displayValue}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
