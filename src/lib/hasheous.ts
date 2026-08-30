// src/lib/hasheous.ts
//
// Hasheous is an open-source hash-to-game database that syncs with IGDB,
// TheGamesDB, GiantBomb, LaunchBox, ScreenScraper, etc.
// Production: https://hasheous.org
// Beta:       https://beta.hasheous.org
//
// TWO SEPARATE CREDENTIALS — do not conflate them, confirmed against
// Hasheous's own source (see the Aug 14 rewrite notes below for how this
// was found):
//   - HASHEOUS_API_KEY, sent as X-API-Key — required for Submissions/FixMatch
//     (push). Lookup/ByHash (pull) is public and works without it.
//   - HASHEOUS_CLIENT_API_KEY, sent as X-Client-API-Key — required for every
//     MetadataProxy/* route (class-level [ClientApiKey()] gate on
//     MetadataProxyController.cs). This is a completely different key,
//     provisioned per registered "App" DataObject on Hasheous
//     (app/{Id}/ClientApiKeys), NOT the same value as HASHEOUS_API_KEY.
//     Only pullIGDBMetadata/pullTheGamesDBMetadata need this — the main
//     lookupByHash/lookupByHashes pull path never did and still doesn't.
//
// Set HASHEOUS_ENV=beta|production in .env alongside both keys.

import { isMappingFieldKey, stripMappingValue } from './mappingFields';

export type HasheousEnv = 'beta' | 'production';

export function getHasheousBaseUrl(env?: HasheousEnv): string {
  const e = env ?? (process.env.HASHEOUS_ENV as HasheousEnv | undefined) ?? 'beta';
  return e === 'production' ? 'https://hasheous.org' : 'https://beta.hasheous.org';
}

// Hasheous's game detail pages use this query-param pattern (confirmed via
// the project maintainer's own example link, since the site is a client-
// rendered SPA and the pattern isn't documented in the swagger):
//   https://hasheous.org/index.html?page=dataobjects&type=game&id={id}
export function getHasheousGameUrl(hasheousId: string, env?: HasheousEnv): string {
  return `${getHasheousBaseUrl(env)}/index.html?page=dataobjectdetail&type=game&id=${hasheousId}`;
}

function getApiKey(): string | null {
  return process.env.HASHEOUS_API_KEY ?? null;
}

function getClientApiKey(): string | null {
  return process.env.HASHEOUS_CLIENT_API_KEY ?? null;
}

// Whether a client key is configured at all — MetadataProxy call sites use
// this to skip gracefully (one clear log line) instead of firing a request
// that's guaranteed to 401, when the key just hasn't been set up yet.
export function hasClientApiKey(): boolean {
  return !!getClientApiKey();
}

function buildHeaders(requireKey = false): HeadersInit {
  const key = getApiKey();
  if (requireKey && !key) throw new Error('HASHEOUS_API_KEY is not configured in .env');
  // Header name confirmed from Hasheous Swagger: X-API-Key (apiKey scheme)
  return {
    'Content-Type': 'application/json',
    ...(key ? { 'X-API-Key': key } : {}),
  };
}

// Separate from buildHeaders() above on purpose — MetadataProxy/* routes
// are gated by a DIFFERENT credential (X-Client-API-Key, confirmed against
// MetadataProxyController.cs's class-level [ClientApiKey()] attribute and
// ClientAPIKeyMiddleware.cs's header name) than Submissions/FixMatch's
// X-API-Key. Sending X-API-Key here wouldn't satisfy this gate even if one
// is configured — they're genuinely different keys tied to different
// registrations on Hasheous's side.
function buildClientHeaders(): HeadersInit {
  const key = getClientApiKey();
  return {
    'Content-Type': 'application/json',
    ...(key ? { 'X-Client-API-Key': key } : {}),
  };
}

// AbortSignal.timeout() was added in Node 17.3 — not available on older
// installs. Using AbortController + setTimeout avoids the compatibility issue.
function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

// ─── Hash lookup ──────────────────────────────────────────────────────────────

// DAT/hash-SIGNATURE match data (which No-Intro/TOSEC/Redump/etc entry this
// file's hash corresponds to) — a genuinely different concept from "which
// external metadata provider does this game map to" (see HasheousMetadataItem
// below). Kept typed but effectively unused for mapping-extraction purposes
// as of the Aug 14 rewrite — see extractMappings()'s comment for why reading
// IDs out of this was the root cause of pull never reliably working.
export interface HasheousSignature {
  signatureSource: string;
  signatureId: string | number;
  signatureGameTitle?: string;
  signatureReleaseDate?: string;
}

// The real per-provider mapping entry — one per MetadataSources enum value,
// confirmed directly against DataObjectItem.cs's MetadataItem class (id,
// source, matchMethod, status, a server-computed link, vote counts). This is
// what result.metadata actually is: an ARRAY of these, not a flat
// {Name, Title, ...} object the way the pre-Aug-14 code assumed.
export interface HasheousMetadataItem {
  id?: string | null;
  source: string; // e.g. "IGDB", "TheGamesDb", "RetroAchievements" — exact Communications.MetadataSources enum string
  matchMethod?: string; // "NoMatch" | "Automatic" | "AutomaticTooManyMatches" | "InProgress" | "Voted" | "Manual" | "ManualByAdmin"
  status?: string;
  // Ready-to-use URL Hasheous itself builds server-side (LinkBuilder in
  // DataObjectItem.cs) — for IGDB specifically this already includes the
  // resolved slug, no separate call needed. Absent/null when the source
  // has no link template or no real id.
  link?: string | null;
  winningVoteCount?: number;
  totalVoteCount?: number;
}

// A curator/IGDB-sourced attribute — Description is the one this project
// currently reads (for canonicalDescription). Confirmed against
// DataObjects.cs's DataObjectDefinitions: Game objects do NOT carry a
// release-date attribute here at all, which is why release date still needs
// the separate MetadataProxy call (see pullIGDBMetadata) rather than coming
// from this array.
export interface HasheousAttributeItem {
  attributeName: string;
  attributeType?: string;
  value?: any;
}

export interface HasheousLookupResult {
  id?: string | number;  // Hasheous returns this as an integer, not a string
  name?: string; // top-level canonical game name — confirmed via HashLookup2.cs, NOT nested inside metadata
  md5?: string;
  sha1?: string;
  crc?: string;
  signatures?: HasheousSignature[] | Record<string, any>;
  metadata?: HasheousMetadataItem[];
  attributes?: HasheousAttributeItem[];
}

export async function lookupByHash(
  hashes: { crc32?: string; md5?: string; sha1?: string },
  env?: HasheousEnv
): Promise<HasheousLookupResult | null> {
  const baseUrl = getHasheousBaseUrl(env);
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/api/v1/Lookup/ByHash`,
      {
        method: 'POST',
        headers: buildHeaders(),
        // PascalCase to match HashLookupModel.cs (MD5/SHA1/SHA256/CRC)
        // exactly — ASP.NET Core's default JSON binding is case-insensitive
        // so lowercase likely also worked, but this integration has been
        // bitten by shape/casing assumptions enough times that it's not
        // worth leaving ambiguous when the fix is free.
        body: JSON.stringify({
          CRC: hashes.crc32 ?? null,
          MD5: hashes.md5 ?? null,
          SHA1: hashes.sha1 ?? null,
        }),
      },
      30000
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Hasheous returned ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? (data[0] ?? null) : data;
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      console.error('[hasheous] lookupByHash timed out after 30s');
    } else {
      console.error('[hasheous] lookupByHash error:', err?.message);
    }
    return null;
  }
}

export async function lookupByHashes(
  hashes: { sha1: string; md5: string; crc32: string },
  env?: HasheousEnv,
  maxRetries = 2
): Promise<HasheousLookupResult | null> {
  const baseUrl = getHasheousBaseUrl(env);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      // Use the POST endpoint — it accepts all three hashes simultaneously,
      // which gives Hasheous more to match on than just the SHA1 alone.
      // Per-request timeout is 12s: short enough that a hanging entry fails
      // fast and the batch can keep going, not so short that a slow-but-valid
      // response gets cut off.
      res = await fetchWithTimeout(
        `${baseUrl}/api/v1/Lookup/ByHash?returnAllSources=true&returnFields=Signatures,Metadata,Attributes`,
        {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify({
            CRC: hashes.crc32,
            MD5: hashes.md5,
            SHA1: hashes.sha1,
          }),
        },
        12000
      );
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        // Timeout — don't retry, just skip this entry and move on
        return null;
      }
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      return null;
    }

    if (res.status === 404) return null;

    if (res.status === 429) {
      const retryAfterRaw = res.headers.get('Retry-After');
      const waitMs = retryAfterRaw
        ? parseInt(retryAfterRaw, 10) * 1000
        : Math.min(3000 * Math.pow(2, attempt), 20000);

      if (attempt < maxRetries) {
        console.warn(`[hasheous] 429 on attempt ${attempt + 1}, waiting ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      return null;
    }

    if (!res.ok) {
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      return null;
    }

    try {
      const data = await res.json();
      return Array.isArray(data) ? (data[0] ?? null) : data;
    } catch {
      return null;
    }
  }
  return null;
}

// Keep old single-hash function for backward compat but delegate to the new one
export async function lookupBySha1(
  sha1: string,
  env?: HasheousEnv
): Promise<HasheousLookupResult | null> {
  const baseUrl = getHasheousBaseUrl(env);
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/api/v1/Lookup/ByHash/sha1/${sha1}`,
      { headers: buildHeaders() },
      12000
    );
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? (data[0] ?? null) : data;
  } catch {
    return null;
  }
}

// ─── Extract mapping IDs from a Hasheous result ───────────────────────────────

export interface ExtractedMappings {
  igdbId?: string;
  igdbSlug?: string;
  theGamesDBId?: string;
  giantBombId?: string;
  launchboxId?: string;
  screenScraperId?: string;
  steamGridDBId?: string;
  retroAchievementsId?: string;
  steamId?: string;
  gogId?: string;
  epicGamesId?: string;
  wikipediaUrl?: string;
  // Ready-made links Hasheous computed server-side, keyed by its own source
  // name (e.g. "GiantBomb"). Full URLs, not run through stripMappingValue —
  // see GameMapping.hasheousLinks for why these are kept at all.
  links?: Record<string, string>;
}

export interface ExtractedCanonicalFields {
  name?: string;
  description?: string;
}

// Canonical name + description straight off the PRIMARY lookup response —
// no separate call needed for either. `name` is Hasheous's own top-level
// `name` field (confirmed via HashLookup2.cs — NOT nested inside metadata,
// which is what the pre-Aug-14 code assumed). `description` comes from the
// Description attribute in `attributes[]`. Release date deliberately isn't
// here — DataObjects.cs's DataObjectDefinitions confirms Game objects don't
// carry a release-date attribute in Hasheous's own model, so that still
// needs the separate MetadataProxy call (see pullIGDBMetadata).
export function extractCanonicalFields(result: HasheousLookupResult): ExtractedCanonicalFields {
  const description = result.attributes?.find(
    (a) => a?.attributeName?.toLowerCase() === 'description'
  )?.value;
  return {
    name: result.name || undefined,
    description: typeof description === 'string' && description ? description : undefined,
  };
}

// Exact Communications.MetadataSources enum strings (confirmed against
// Communications.cs — Hasheous serializes this via JsonStringEnumConverter,
// so casing matters). Wikipedia deliberately excluded here — its
// wikipediaUrl is populated from the source's `link` below instead of a raw
// `id`, since a bare Wikipedia page identifier isn't the URL shape this
// field is meant to hold.
const SOURCE_TO_ID_FIELD: Record<string, keyof ExtractedMappings> = {
  IGDB: 'igdbId',
  TheGamesDb: 'theGamesDBId',
  GiantBomb: 'giantBombId',
  LaunchBox: 'launchboxId',
  ScreenScraper: 'screenScraperId',
  SteamGridDb: 'steamGridDBId',
  RetroAchievements: 'retroAchievementsId',
  Steam: 'steamId',
  GOG: 'gogId',
  EpicGameStore: 'epicGamesId',
};

// THE CORE AUG-14 FIX: reads result.metadata (an array of {id, source,
// matchMethod, status, link, ...} — confirmed against DataObjectItem.cs's
// MetadataItem class) instead of result.signatures. Those are genuinely
// different things — signatures is DAT/hash-SIGNATURE match data (which
// No-Intro/TOSEC/Redump/etc entry this file's hash corresponds to), not
// "which IGDB/RetroAchievements/etc game ID does this map to." The old
// signatures-based extraction (removed here, see git history) had been
// reading the wrong concept entirely since this feature was first built —
// metadata[] is what Hasheous's own UI and dump files actually treat as the
// mapping table, and this project had never read it.
export function extractMappings(result: HasheousLookupResult): ExtractedMappings {
  const items = Array.isArray(result.metadata) ? result.metadata : [];

  const raw: Record<string, string> = {};
  const links: Record<string, string> = {};

  for (const item of items) {
    if (!item?.source) continue;
    // Hasheous backfills a NoMatch row for every source on every object, so
    // most entries here have no real id — skip those rather than branching
    // on every possible non-matched matchMethod value.
    if (item.id == null || item.id === '') continue;
    if (typeof item.id === 'object') continue; // defensive — never stringify an object into the DB again, same guard the old code had

    if (item.link) links[item.source] = item.link;

    const field = SOURCE_TO_ID_FIELD[item.source];
    if (field) raw[field] = String(item.id);
  }

  if (links['Wikipedia']) raw['wikipediaUrl'] = links['Wikipedia'];

  // IGDB slug: extracted from the link Hasheous already computed
  // (template confirmed as "https://www.igdb.com/games/{slug}" against
  // DataObjectItem.cs's LinkBuilder) rather than a separate MetadataProxy
  // call — works with zero extra auth, on every pull, not just ones where a
  // client key happens to be configured.
  const igdbSlugMatch = links['IGDB']?.match(/\/games\/([^/?#]+)/);
  if (igdbSlugMatch) raw['igdbSlug'] = igdbSlugMatch[1];

  // Defense in depth: whatever Hasheous actually sends, normalize it the
  // same way manual user entry is normalized (MappingsSection.tsx /
  // stripMappingValue), so a full URL never lands in an ID field regardless
  // of source. igdbSlug isn't in MAPPING_FIELD_KEYS (not directly
  // user-editable) so it passes through unstripped, same as before.
  const stripped: ExtractedMappings = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value) continue;
    (stripped as Record<string, string>)[key] = isMappingFieldKey(key)
      ? stripMappingValue(key, value)
      : value;
  }
  if (Object.keys(links).length > 0) stripped.links = links;
  return stripped;
}

// ─── Push (FixMatch) ──────────────────────────────────────────────────────────

export interface HasheousPushPayload {
  hashes: { crc32?: string; md5?: string; sha1?: string };
  mappings: {
    igdbId?: string;
    theGamesDBId?: string;
    giantBombId?: string;
    launchboxId?: string;
    screenScraperId?: string;
    steamGridDBId?: string;
    retroAchievementsId?: string;
    gogId?: string;
    epicGamesId?: string;
  };
}

// Response from Submissions/FixMatch is a per-source status map, e.g.
// {"IGDB":"OK","RetroAchievements":"12345 - Not Found"} — confirmed against
// Submissions.cs's AddVote, which validates each proposed id against the
// actual provider before recording anything. A 200 HTTP status only means
// the REQUEST was well-formed; it says nothing about whether any individual
// source's id was accepted.
export interface HasheousPushResult {
  ok: boolean;
  error?: string;
  // Which pushed fields Hasheous actually accepted vs rejected, keyed by the
  // SAME GameMapping field names the caller passed in (igdbId, not "IGDB")
  // so callers never need their own source-name translation table.
  // Undefined if the response couldn't be parsed for some reason — callers
  // should treat that as unknown rather than assume acceptance.
  accepted?: string[];
  rejected?: Record<string, string>; // field name -> the rejection message Hasheous returned
}

export async function pushMappingToHasheous(
  payload: HasheousPushPayload,
  env?: HasheousEnv
): Promise<HasheousPushResult> {
  const baseUrl = getHasheousBaseUrl(env);

  // CONFIRMED against Hasheous's actual source (SubmissionsModel.cs, class
  // SubmissionsMatchFixModel): every source's ID goes into a single
  // MetadataMatches array of { Source, GameId } pairs, where Source is a C#
  // enum (Communications.MetadataSources) serialized as its string name.
  // GOG and EpicGameStore added here (Aug 14) — both are valid
  // MetadataSources values this project has a GameMapping column for
  // (gogId/epicGamesId) but had never actually included in a push before.
  // Wikipedia is deliberately still not pushed — HackHash stores a full URL
  // for it (wikipediaUrl), and the exact GameId format Hasheous expects for
  // that source isn't confirmed from source; guessing at it risks silently
  // submitting garbage votes rather than just not pushing that one field.
  const sourceMap: { field: string; value: string | undefined; source: string }[] = [
    { field: 'igdbId', value: payload.mappings.igdbId, source: 'IGDB' },
    { field: 'theGamesDBId', value: payload.mappings.theGamesDBId, source: 'TheGamesDb' },
    { field: 'retroAchievementsId', value: payload.mappings.retroAchievementsId, source: 'RetroAchievements' },
    { field: 'giantBombId', value: payload.mappings.giantBombId, source: 'GiantBomb' },
    { field: 'screenScraperId', value: payload.mappings.screenScraperId, source: 'ScreenScraper' },
    { field: 'steamGridDBId', value: payload.mappings.steamGridDBId, source: 'SteamGridDb' },
    { field: 'launchboxId', value: payload.mappings.launchboxId, source: 'LaunchBox' },
    { field: 'gogId', value: payload.mappings.gogId, source: 'GOG' },
    { field: 'epicGamesId', value: payload.mappings.epicGamesId, source: 'EpicGameStore' },
  ];
  const active = sourceMap.filter((s) => s.value);
  const MetadataMatches = active.map((s) => ({ Source: s.source, GameId: s.value }));

  if (MetadataMatches.length === 0) {
    return { ok: false, error: 'No mapping IDs to push' };
  }

  // Reverse lookup used below to translate Hasheous's source-keyed response
  // back into the field names the caller actually passed in.
  const sourceToField: Record<string, string> = Object.fromEntries(
    active.map((s) => [s.source, s.field])
  );

  const body = {
    MD5: payload.hashes.md5 ?? null,
    SHA1: payload.hashes.sha1 ?? null,
    SHA256: null,
    CRC: payload.hashes.crc32 ?? null,
    DataObjectId: null,
    MetadataMatches,
  };

  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/api/v1/Submissions/FixMatch`,
      { method: 'POST', headers: buildHeaders(true), body: JSON.stringify(body) },
      30000
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[hasheous] FixMatch push failed: HTTP ${res.status} for ${JSON.stringify(body)} — response: ${text.slice(0, 500)}`);
      return {
        ok: false,
        error: `Hasheous returned HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
      };
    }

    // IMPORTANT (Aug 14 fix): this used to log the response and return
    // {ok:true} unconditionally on a 200, meaning an outright-rejected id
    // (typo, stale id, whatever) got recorded the same as a genuinely
    // accepted one — both would sit as "pending, awaiting confirmation"
    // forever, the rejected one never able to confirm since Hasheous never
    // recorded a vote for it in the first place. Now actually parsed.
    const resultText = await res.text().catch(() => '');
    let statusMap: Record<string, string> | null = null;
    try {
      statusMap = JSON.parse(resultText);
    } catch {
      statusMap = null;
    }

    if (!statusMap || typeof statusMap !== 'object') {
      console.warn(`[hasheous] FixMatch returned 200 but the response body wasn't the expected per-source status map: ${resultText.slice(0, 300)}`);
      return { ok: true }; // can't tell what was accepted — treat as unknown, not a failure
    }

    const accepted: string[] = [];
    const rejected: Record<string, string> = {};
    for (const [source, status] of Object.entries(statusMap)) {
      const field = sourceToField[source] ?? source; // fall back to the raw source name if it's one we didn't send (shouldn't happen)
      if (typeof status === 'string' && status.trim().toUpperCase() === 'OK') {
        accepted.push(field);
      } else {
        rejected[field] = String(status);
      }
    }
    if (Object.keys(rejected).length > 0) {
      console.warn(`[hasheous] FixMatch rejected some fields: ${JSON.stringify(rejected)}`);
    }
    console.log(`[hasheous] FixMatch push accepted=[${accepted.join(', ')}] rejected=${JSON.stringify(rejected)}`);

    return { ok: true, accepted, rejected };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return { ok: false, error: 'Request timed out after 30s — Hasheous may be slow or unavailable' };
    }
    return { ok: false, error: err?.message ?? 'Network error' };
  }
}

// ─── Pull canonical metadata via Hasheous MetadataProxy ──────────────────────

export interface CanonicalMetadata {
  name?: string;
  releaseDate?: string;
  summary?: string;
  // IGDB's own numeric ID doesn't resolve to a working igdb.com/games/ URL —
  // that path needs the text slug (e.g. "zelda-ocarina-of-time"), which IGDB
  // only exposes as a separate `slug` field, not derivable from the ID.
  // Without it, a link built from the ID alone lands on IGDB's search page.
  slug?: string;
  source: string;
}

export async function pullIGDBMetadata(
  igdbId: string,
  env?: HasheousEnv
): Promise<CanonicalMetadata | null> {
  // SECOND, SEPARATE BUG on top of the URL fix below (found Aug 14):
  // MetadataProxy/* is gated behind a DIFFERENT credential than the one
  // this project has ever configured — X-Client-API-Key, not X-API-Key —
  // confirmed via MetadataProxyController.cs's class-level [ClientApiKey()]
  // attribute (every route in that controller requires it except the
  // image/media passthrough ones, which IGDB/Game isn't). Even with the
  // correct URL below, every call here has almost certainly been 401ing
  // this whole time. See HASHEOUS_CLIENT_API_KEY in .env.example for how to
  // get one (register/use an "App" on Hasheous, generate a key from it).
  if (!hasClientApiKey()) {
    console.log('[hasheous] pullIGDBMetadata skipped — HASHEOUS_CLIENT_API_KEY is not configured, so this call would just 401. IGDB id/link extraction (the common case) doesn\'t need this; only release date/summary enrichment does.');
    return null;
  }

  const baseUrl = getHasheousBaseUrl(env);
  // CONFIRMED against Hasheous's actual source (MetadataProxyController.cs,
  // [Route("IGDB/{MetadataType}")], method signature
  // GetMetadata(string MetadataType, long Id, string slug = "", ...)):
  // MetadataType is a PATH segment and must be the exact C# class name in
  // the IGDB.Models namespace — "Game" (singular), NOT "Games". Id is a
  // QUERY parameter (capital I), NOT a path segment.
  //
  // This was the actual, source-code-confirmed bug behind IGDB links never
  // resolving: the old URL (.../IGDB/Games/{id}) doesn't match any real
  // route. Games (plural) isn't a class in IGDB.Models — only Game is — so
  // the controller's reflection lookup (`igdbAssembly.GetType("IGDB.Models." 
  // + MetadataType)`) would return null and the request would 400 before
  // ever reading the ID, which also was never actually being read anyway,
  // since there's no {Id} route template segment, only {MetadataType}.
  const url = `${baseUrl}/api/v1/MetadataProxy/IGDB/Game?Id=${igdbId}`;
  try {
    const res = await fetchWithTimeout(url, { headers: buildClientHeaders() }, 30000);
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '(could not read response body)');
      console.error(`[hasheous] pullIGDBMetadata: HTTP ${res.status} ${res.statusText} for igdbId=${igdbId} — ${url} — body: ${bodyText.slice(0, 500)}${res.status === 401 ? ' — check HASHEOUS_CLIENT_API_KEY is set and valid' : ''}`);
      return null;
    }
    const data = await res.json();

    // The response is a flat Dictionary<string,object> built by reflecting
    // over HasheousClient.Models.Metadata.IGDB.Game's properties, keyed by
    // each property's [JsonProperty(...)] attribute value (confirmed from
    // source — see MetadataProxyController.cs's _GetMetadata). That
    // attribute's exact string wasn't visible (Game.cs lives in the
    // separate hasheous-client repo, not this one) but Newtonsoft.Json
    // JsonProperty attributes on a PascalCase C# property (IGDB.Models.Game.
    // Slug, confirmed elsewhere in this codebase) are used specifically to
    // produce clean camelCase JSON, so "slug" is the well-motivated
    // default assumption — PascalCase is still checked as a fallback.
    const slug = data.slug ?? data.Slug ?? undefined;
    const name = data.name ?? data.Name ?? data.title ?? data.Title;
    const releaseDateRaw = data.first_release_date ?? data.FirstReleaseDate ?? data.first_release_date_at;
    const summary = data.summary ?? data.Summary;

    console.log(`[hasheous] pullIGDBMetadata igdbId=${igdbId}: response keys=[${Object.keys(data).join(', ')}], resolved slug=${slug ?? '(none found — checked slug/Slug)'}`);

    return {
      name,
      releaseDate: releaseDateRaw ? new Date(releaseDateRaw * 1000).toISOString().split('T')[0] : undefined,
      summary,
      slug,
      source: 'IGDB',
    };
  } catch (err: any) {
    console.error(`[hasheous] pullIGDBMetadata threw for igdbId=${igdbId}, url=${url}: ${err?.name ?? ''} ${err?.message ?? err}`);
    return null;
  }
}

export function getIGDBGameUrl(slug: string): string {
  return `https://www.igdb.com/games/${slug}`;
}

export async function pullTheGamesDBMetadata(
  tgdbId: string,
  env?: HasheousEnv
): Promise<CanonicalMetadata | null> {
  // Same missing-credential bug as pullIGDBMetadata above — MetadataProxy/*
  // is gated behind X-Client-API-Key regardless of which provider it's
  // proxying to.
  if (!hasClientApiKey()) {
    console.log('[hasheous] pullTheGamesDBMetadata skipped — HASHEOUS_CLIENT_API_KEY is not configured.');
    return null;
  }
  const baseUrl = getHasheousBaseUrl(env);
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/api/v1/MetadataProxy/TheGamesDB/Games?id=${tgdbId}`,
      { headers: buildClientHeaders() },
      30000
    );
    if (!res.ok) return null;
    const data = await res.json();
    const game = data?.data?.games?.[0] ?? data?.games?.[0] ?? data;
    return {
      name: game?.game_title ?? game?.title,
      releaseDate: game?.release_date,
      summary: game?.overview,
      source: 'TheGamesDB',
    };
  } catch (err: any) {
    if (err?.name === 'AbortError') console.error('[hasheous] pullTheGamesDBMetadata timed out');
    return null;
  }
}
