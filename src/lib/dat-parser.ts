'use client';

// src/lib/dat-parser.ts
// Parses Logiqx-style DAT XML (and our own JSON export format) entirely in
// the browser. These files contain only metadata/hashes — never ROM data —
// so parsing them client-side is just for consistency with the rest of the
// app's "heavy lifting happens locally" approach, not a privacy requirement.

export interface ParsedDatEntry {
  machineName: string;
  description: string;
  romName: string;
  size: string; // kept as a string to avoid precision loss before BigInt conversion
  crc32: string;
  md5: string;
  sha1: string;
  // Present only when the source JSON already provides these explicitly
  // (e.g. our own "detailed" export, under details.hackName/details.version)
  // — when present, these are trusted over the regex-based split in
  // splitNameVersion() below, since they're the real values, not a guess.
  hackName?: string;
  version?: string;
  // Everything below is present only for a "detailed" export re-import —
  // absent for a plain DAT XML or lean JSON source. All optional; the
  // import API only persists what's actually present.
  author?: string;
  versionChangelog?: string; // what changed in THIS version — detailed-export-only, like author/releaseYear below, never derivable from name-parsing
  translationLanguages?: string[]; // language codes — per-version, same reasoning as versionChangelog above
  releaseYear?: number;
  releaseDate?: string; // ISO 'YYYY-MM-DD', when the exact date is known — see releaseYear's own comment in prisma/schema.prisma for why this is a separate, additive field
  realDescription?: string; // the actual prose description — NOT `description` above, which is the DAT-convention name-duplicate
  tags?: string[]; // slugs, not display names — see note in dat-generator.ts
  patchType?: string;
  patchFilename?: string;
  patchSha1?: string;
  // The base rom this entry's patch expects, if the source database had
  // one recorded (see src/lib/baseRom.ts) — present only for a "detailed"
  // export re-import. status is carried through so re-importing an already-
  // approved base rom doesn't reset it to pending.
  baseRom?: {
    name: string;
    platform: string;
    crc32: string;
    md5: string;
    sha1: string;
    status?: string;
  };
  sourceUrl?: string;
  releasePageUrl?: string;
  githubUrl?: string;
  notes?: string;
  gameDatabaseLinks?: {
    igdbId?: string;
    igdbSlug?: string;
    theGamesDBId?: string;
    launchboxId?: string;
    giantBombId?: string;
    screenScraperId?: string;
    steamGridDBId?: string;
    retroAchievementsId?: string;
    steamId?: string;
    gogId?: string;
    epicGamesId?: string;
    wikipediaUrl?: string;
    canonicalName?: string;
    hasheousId?: string;
  };
  // The hack-family this entry belonged to in the source database (see
  // src/lib/hackFamily.ts) — present only for a "detailed" export
  // re-import. Lets the import route (POST /api/admin/import) regroup
  // versions back together instead of every re-imported entry starting as
  // its own disconnected family. Matched by name + platform on import, not
  // trusted as an id (a fresh import always creates new HackFamily rows).
  hackFamily?: {
    name: string;
    author?: string;
    releaseYear?: number;
    releaseDate?: string;
    description?: string;
  };
}

export interface ValidatedEntry extends ParsedDatEntry {
  hackName: string;
  version: string;
  valid: boolean;
  issue?: string;
}

const HEX8 = /^[0-9a-f]{8}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX40 = /^[0-9a-f]{40}$/;

// ─── XML (Logiqx DAT) ───────────────────────────────────────────────────────

export function parseDatXml(xmlText: string): ParsedDatEntry[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');

  if (doc.querySelector('parsererror')) {
    throw new Error('This file is not valid XML — make sure it\'s an unmodified DAT file.');
  }

  // Logiqx DATs use <machine>, older No-Intro DATs sometimes use <game>
  const nodes = Array.from(doc.querySelectorAll('machine, game'));
  if (nodes.length === 0) {
    throw new Error('No <machine> or <game> entries found — is this a DAT file?');
  }

  return nodes
    .map((node): ParsedDatEntry => {
      const machineName = node.getAttribute('name') ?? '';
      const descNode = node.querySelector('description');
      const description = descNode?.textContent?.trim() || machineName;
      const romNode = node.querySelector('rom');

      return {
        machineName: machineName.trim(),
        description,
        romName: romNode?.getAttribute('name')?.trim() ?? machineName.trim(),
        size: romNode?.getAttribute('size')?.trim() ?? '0',
        crc32: (romNode?.getAttribute('crc') ?? '').trim().toLowerCase(),
        md5: (romNode?.getAttribute('md5') ?? '').trim().toLowerCase(),
        sha1: (romNode?.getAttribute('sha1') ?? '').trim().toLowerCase(),
      };
    })
    .filter((e) => e.machineName);
}

// ─── JSON (our own export format, or a raw array of similarly-shaped objects) ──

export function parseDatJson(jsonText: string): ParsedDatEntry[] {
  let data: any;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new Error('This file is not valid JSON.');
  }

  // "machines" is the real key (matches the lean JSON export and our own
  // "detailed" export). "entries" is accepted too, purely defensively, in
  // case of hand-edited files or a future export using that name instead.
  const machines = Array.isArray(data) ? data : (data.machines ?? data.entries);
  if (!Array.isArray(machines)) {
    throw new Error('Could not find a "machines" array in this JSON file.');
  }

  return machines
    .map((m: any): ParsedDatEntry => {
      // Our "detailed" export nests the richer fields under `details` so
      // they can't collide with the plain DAT-shaped fields above it —
      // pull hackName/version out from there if present, since they're
      // real values rather than a guess.
      const d = m.details;
      const hackName = d?.hackName ?? m.hackName;
      const version = d?.version ?? m.version;

      // Tags come as {slug, name} pairs from our own export — but accept a
      // bare string too, defensively, treating it as already being the slug.
      const tags: string[] | undefined = Array.isArray(d?.tags)
        ? d.tags.map((t: any) => (typeof t === 'string' ? t : t?.slug)).filter(Boolean)
        : undefined;

      const gdl = d?.gameDatabaseLinks;
      const gameDatabaseLinks = gdl
        ? {
            igdbId: gdl.igdb?.id || undefined,
            igdbSlug: gdl.igdb?.slug || undefined,
            theGamesDBId: gdl.theGamesDB || undefined,
            launchboxId: gdl.launchbox || undefined,
            giantBombId: gdl.giantBomb || undefined,
            screenScraperId: gdl.screenScraper || undefined,
            steamGridDBId: gdl.steamGridDB || undefined,
            retroAchievementsId: gdl.retroAchievements || undefined,
            steamId: gdl.steam || undefined,
            gogId: gdl.gog || undefined,
            epicGamesId: gdl.epicGames || undefined,
            wikipediaUrl: gdl.wikipedia || undefined,
            canonicalName: gdl.canonicalName || undefined,
            hasheousId: gdl.hasheousId || undefined,
          }
        : undefined;

      const hf = d?.hackFamily;
      const hackFamily = hf?.name
        ? {
            name: String(hf.name).trim(),
            ...(hf.author ? { author: String(hf.author).trim() } : {}),
            ...(typeof hf.releaseYear === 'number' ? { releaseYear: hf.releaseYear } : {}),
            ...(typeof hf.releaseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(hf.releaseDate) ? { releaseDate: hf.releaseDate } : {}),
            ...(hf.description ? { description: String(hf.description).trim() } : {}),
          }
        : undefined;

      return {
        machineName: String(m.machineName ?? m.name ?? '').trim(),
        description: String(m.description ?? m.machineName ?? m.name ?? '').trim(),
        romName: String(m.rom?.name ?? m.romName ?? m.machineName ?? '').trim(),
        size: String(m.rom?.size ?? m.fileSize ?? m.size ?? '0'),
        crc32: String(m.rom?.crc ?? m.crc32 ?? '').trim().toLowerCase(),
        md5: String(m.rom?.md5 ?? m.md5 ?? '').trim().toLowerCase(),
        sha1: String(m.rom?.sha1 ?? m.sha1 ?? '').trim().toLowerCase(),
        ...(hackName ? { hackName: String(hackName).trim() } : {}),
        ...(version ? { version: String(version).trim() } : {}),
        ...(d?.author ? { author: String(d.author).trim() } : {}),
        ...(d?.versionChangelog ? { versionChangelog: String(d.versionChangelog).trim() } : {}),
        ...(Array.isArray(d?.translationLanguages) && d.translationLanguages.length
          ? { translationLanguages: d.translationLanguages.filter((c: unknown) => typeof c === 'string') }
          : {}),
        ...(typeof d?.releaseYear === 'number' ? { releaseYear: d.releaseYear } : {}),
        ...(typeof d?.releaseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.releaseDate) ? { releaseDate: d.releaseDate } : {}),
        ...(d?.description ? { realDescription: String(d.description).trim() } : {}),
        ...(tags?.length ? { tags } : {}),
        ...(d?.patch?.type ? { patchType: String(d.patch.type).trim() } : {}),
        ...(d?.patch?.filename ? { patchFilename: String(d.patch.filename).trim() } : {}),
        ...(d?.patch?.sha1 ? { patchSha1: String(d.patch.sha1).trim() } : {}),
        ...(d?.baseRom?.name && d?.baseRom?.sha1 && d?.baseRom?.crc32 && d?.baseRom?.md5
          ? {
              baseRom: {
                name: String(d.baseRom.name).trim(),
                platform: String(d.baseRom.platform ?? '').trim(),
                crc32: String(d.baseRom.crc32).trim().toLowerCase(),
                md5: String(d.baseRom.md5).trim().toLowerCase(),
                sha1: String(d.baseRom.sha1).trim().toLowerCase(),
                ...(d.baseRom.status ? { status: String(d.baseRom.status).trim() } : {}),
              },
            }
          : {}),
        ...(d?.sourceUrl ? { sourceUrl: String(d.sourceUrl).trim() } : {}),
        ...(d?.releasePageUrl ? { releasePageUrl: String(d.releasePageUrl).trim() } : {}),
        ...(d?.githubUrl ? { githubUrl: String(d.githubUrl).trim() } : {}),
        ...(d?.notes ? { notes: String(d.notes).trim() } : {}),
        ...(gameDatabaseLinks && Object.values(gameDatabaseLinks).some(Boolean) ? { gameDatabaseLinks } : {}),
        ...(hackFamily ? { hackFamily } : {}),
      };
    })
    .filter((e) => e.machineName);
}

export interface DismissedDuplicatePair {
  platform: string;
  nameA: string;
  nameB: string;
}

// Only meaningful for our own "detailed" JSON export — pulls the top-level
// dismissedDuplicates list out separately from the per-entry parsing above,
// rather than folding it into parseDatJson's return type, since it isn't a
// per-entry thing and every other caller of parseDatFile (XML, lean JSON)
// has no use for it. Best-effort: returns [] for anything that isn't our
// own detailed export shape, never throws.
export function extractDismissedDuplicates(filename: string, text: string): DismissedDuplicatePair[] {
  if (!filename.toLowerCase().endsWith('.json')) return [];
  try {
    const data = JSON.parse(text);
    const list = data?.dismissedDuplicates;
    if (!Array.isArray(list)) return [];
    return list
      .filter((d: any) => d?.platform && d?.nameA && d?.nameB)
      .map((d: any) => ({ platform: String(d.platform), nameA: String(d.nameA).trim(), nameB: String(d.nameB).trim() }));
  } catch {
    return [];
  }
}

// ─── Dispatch by filename/content ─────────────────────────────────────────────

export function parseDatFile(filename: string, text: string): ParsedDatEntry[] {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.json')) return parseDatJson(text);
  if (lower.endsWith('.dat') || lower.endsWith('.xml')) return parseDatXml(text);

  // Fall back to sniffing the content itself
  const trimmed = text.trim();
  if (trimmed.startsWith('<')) return parseDatXml(text);
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseDatJson(text);

  throw new Error('Could not determine file type — expected .dat, .xml, or .json.');
}

// ─── Name/version splitting + validation ──────────────────────────────────────

// Two patterns, tried in order:
// 1. An EXPLICIT "v"/"version" prefix, e.g. "Hack (v1.0)", "Hack (Version
//    1.0)", "Hack (vNormal Mode)", "Hack (v2.5 1.0)". The prefix is trusted
//    as a strong, deliberate signal specifically used for versions/variants
//    in this domain — so once it's present, whatever follows is taken as
//    the version as-is, numeric or not. Found from real submissions: a hack
//    versioned by mode/edition name rather than a number ("(vNormal Mode)",
//    "(vSpeedrun Mode)") was falling all the way through to the "no match"
//    default (whole string as the name, version forced to "1.0") because
//    the old pattern required the version to START WITH A DIGIT even after
//    an explicit "v" prefix — meaning two versions of the same hack got
//    different, un-family-matchable names AND identical wrong "1.0"
//    versions. Same fix also handles messy real-world input like
//    "(v2.5 1.0)" that isn't cleanly one number.
// 2. No prefix at all, digit-led only, e.g. "Hack (1.0a)" — kept exactly as
//    strict as before specifically so a non-version parenthetical never
//    gets mistaken for one. Deliberately NOT broadened to match arbitrary
//    text without a "v" prefix — region/language tags like "(USA)",
//    "(Japan)", status tags like "(Beta)" don't use the v-prefix
//    convention, so requiring it here (unlike case 1) is what keeps those
//    from being misread as a version.
const VERSION_PATTERN_PREFIXED = /^(.*?)\s*\(\s*v(?:ersion)?\.?\s*([^)]+?)\s*\)\s*$/i;
const VERSION_PATTERN_BARE = /^(.*?)\s*\(\s*([\d][\d.]*[a-zA-Z]*)\s*\)\s*$/;

// A collision-resolution tag (a 7-lowercase-hex-char disambiguator in
// square brackets, appended by resolveMachineName in src/lib/approval.ts
// when two different-hash hacks would otherwise produce an identical DAT
// name) is DAT-export-only metadata, not part of the hack's name — strip it
// before parsing so a plain-DAT re-import doesn't fold it into hackName.
// Disposable here: a re-imported submission gets a fresh machineName (and
// a fresh collision check) the next time it's actually approved, so
// there's nothing worth preserving by carrying the old tag through.
const COLLISION_TAG = /\s*\[[0-9a-f]{7}\]$/;

export function splitNameVersion(machineName: string): { hackName: string; version: string } {
  const withoutTag = machineName.replace(COLLISION_TAG, '');
  const prefixed = withoutTag.match(VERSION_PATTERN_PREFIXED);
  if (prefixed && prefixed[1].trim() && prefixed[2].trim()) {
    return { hackName: prefixed[1].trim(), version: prefixed[2].trim() };
  }
  const bare = withoutTag.match(VERSION_PATTERN_BARE);
  if (bare && bare[1].trim()) {
    return { hackName: bare[1].trim(), version: bare[2].trim() };
  }
  return { hackName: withoutTag.trim(), version: '1.0' };
}

export function validateEntries(entries: ParsedDatEntry[]): ValidatedEntry[] {
  return entries.map((e) => {
    // Prefer explicit hackName/version when the source provided them (our
    // own "detailed" export always does) — only fall back to guessing by
    // splitting "Hack Name (v1.0)" apart when they're genuinely absent,
    // which is the normal case for plain DAT XML or the lean JSON export.
    const { hackName, version } = e.hackName && e.version
      ? { hackName: e.hackName, version: e.version }
      : splitNameVersion(e.machineName);
    let issue: string | undefined;

    if (!HEX40.test(e.sha1)) issue = 'Missing or malformed SHA-1';
    else if (!HEX32.test(e.md5)) issue = 'Missing or malformed MD5';
    else if (!HEX8.test(e.crc32)) issue = 'Missing or malformed CRC32';
    else if (!/^\d+$/.test(e.size)) issue = 'Missing or malformed file size';
    else if (!e.romName) issue = 'Missing ROM filename';

    return { ...e, hackName, version, valid: !issue, issue };
  });
}
