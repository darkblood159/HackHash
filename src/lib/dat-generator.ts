// src/lib/dat-generator.ts
import { prisma } from './prisma';
import { PLATFORM_LABELS } from '@/types';
import { isMappingFieldKey, stripMappingValue } from './mappingFields';
import { getDismissedPairsForExport, toISODateOnly, type DismissedPairExport } from './hackFamily';

interface DATHeader {
  name: string;
  description: string;
  version: string;
  date: string;
  author: string;
  url: string;
}

interface DATMachine {
  machineName: string;
  description: string;
  romName: string;
  fileSize: string;
  crc32: string;
  md5: string;
  sha1: string;
}

// The "detailed" export — a separate, richer format from the lean DAT above.
// Deliberately NOT shoehorned into DAT-XML: that format's whole job is fast
// hash verification for ROM-management tools (RomVault, ClrMamePro, etc),
// which only ever read name/description/rom/crc/md5/sha1 — cramming tags,
// notes, and game-database links into that file would bloat it for zero
// benefit to the tools consuming it. This is a full archival/reference copy
// instead: every field this project tracks about a hack, as JSON.
//
// IMPORTANT: the top-level fields (machineName/description/romName/
// platform/fileSize/crc32/md5/sha1) deliberately mirror DATMachine exactly,
// and `description` deliberately holds the DAT-convention value (same as
// machineName), NOT the hack's real prose description — that lives under
// `details.description` instead. This is so the file can be re-uploaded
// through the same import form used for a plain DAT/lean-JSON export
// (src/components/ImportDatForm.tsx -> src/lib/dat-parser.ts) without any
// transformation. Everything importer-irrelevant lives under `details`,
// which the importer simply ignores.
interface DetailedEntry {
  machineName: string;
  description: string; // DAT convention — same as machineName, see note above
  romName: string;
  platform: string;
  fileSize: string;
  crc32: string;
  md5: string;
  sha1: string;

  details: {
    hackName: string;
    version: string;
    versionChangelog: string | null; // what changed in THIS version specifically — never on hackFamily below, that's shared-field territory, this deliberately isn't
    // Which language(s) this version was translated into, e.g. ["es","fr"]
    // — per-version like versionChangelog above, for the same reason: a
    // translation added in v1.1 shouldn't silently apply to v1.0's entry.
    translationLanguages: string[];
    author: string | null;
    releaseYear: number | null;
    // ISO 'YYYY-MM-DD', when the exact date is known — a separate field
    // from releaseYear above rather than replacing it, same "don't
    // fabricate precision that isn't there" reasoning as the schema
    // itself (see prisma/schema.prisma's comment on Submission.releaseDate).
    // null when only the year is known, or neither.
    releaseDate: string | null;
    description: string | null; // the actual prose description
    // {slug, name} rather than a bare name — the slug is what tag
    // resolution actually matches on (see ensureTagsExist in
    // src/lib/tags.ts); a bare display name like "Translation" wouldn't
    // match anything and would silently import with no tags at all, the
    // same class of bug fixed twice already for this feature.
    tags: { slug: string; name: string }[];

    // The hack-family this version belongs to, if grouped yet (see
    // src/lib/hackFamily.ts). Included so a full database rebuild from this
    // export can regroup versions back together instead of losing that —
    // entries sharing the same hackFamily.name + platform get relinked to
    // one family on re-import (POST /api/admin/import). null if this
    // submission hasn't been grouped (shouldn't normally happen once the
    // backfill's been run, but exported as null rather than guessed).
    hackFamily: {
      name: string;
      author: string | null;
      releaseYear: number | null;
      releaseDate: string | null;
      description: string | null;
    } | null;

    patch: {
      type: string | null;
      filename: string | null;
      sha1: string | null;
    };
    // Reference to the UNPATCHED source ROM this hack's patch expects —
    // separate from the top-level crc32/md5/sha1 on the entry itself, which
    // hash the finished/patched ROM this submission is actually about.
    // Includes status so a re-import can preserve an already-approved base
    // rom's approval state rather than resetting it to pending — see
    // resolveOrCreateBaseRom in src/lib/baseRom.ts.
    baseRom: {
      name: string;
      platform: string;
      crc32: string;
      md5: string;
      sha1: string;
      status: string;
    } | null;

    sourceUrl: string | null;
    releasePageUrl: string | null;
    githubUrl: string | null;
    notes: string | null;

    gameDatabaseLinks: {
      canonicalName: string | null;
      igdb: { id: string | null; slug: string | null };
      theGamesDB: string | null;
      launchbox: string | null;
      giantBomb: string | null;
      screenScraper: string | null;
      steamGridDB: string | null;
      retroAchievements: string | null;
      steam: string | null;
      gog: string | null;
      epicGames: string | null;
      wikipedia: string | null;
      hasheousId: string | null;
    } | null;

    approvedAt: string;
  };
}

// ─── Fetch approved entries ───────────────────────────────────────────────────

export async function getApprovedEntries(platform?: string): Promise<DATMachine[]> {
  const entries = await prisma.approvedEntry.findMany({
    where: {
      submission: { deletedAt: null },
      ...(platform ? { platform: platform as any } : {}),
    },
    orderBy: { machineName: 'asc' },
  });

  return entries.map((e) => ({
    machineName: e.machineName,
    description: e.description,
    romName: e.romName,
    fileSize: e.fileSize.toString(),
    crc32: e.crc32.toLowerCase(),
    md5: e.md5.toLowerCase(),
    sha1: e.sha1.toLowerCase(),
  }));
}

export async function getDetailedApprovedEntries(platform?: string): Promise<DetailedEntry[]> {
  const entries = await prisma.approvedEntry.findMany({
    where: {
      // Same scope as the lean export — approved, not soft-deleted. This
      // export is a richer view of the exact same dataset, not a different
      // one, so it should never show something the lean DAT wouldn't.
      submission: { deletedAt: null },
      ...(platform ? { platform: platform as any } : {}),
    },
    include: {
      submission: {
        include: {
          gameMapping: true,
          tags: { include: { tag: true } },
          hackFamily: true,
          baseRom: true,
        },
      },
    },
    orderBy: { machineName: 'asc' },
  });

  return entries.map((e) => {
    const sub = e.submission;
    const m = sub?.gameMapping;
    // Defensive: strips a pasted URL down to a clean ID, and clears known
    // corruption artifacts (e.g. "[object Object]" from a since-fixed bug)
    // — same protection MappingsDisplay.tsx applies at render time, applied
    // here too so a raw export never shows what the live UI wouldn't.
    const clean = (key: string, value: string | null | undefined): string | null => {
      if (!value) return null;
      const stripped = isMappingFieldKey(key) ? stripMappingValue(key, value) : value;
      return stripped || null;
    };

    return {
      machineName: e.machineName,
      description: e.description, // DAT convention (= machineName), not the real description
      romName: e.romName,
      platform: e.platform,
      fileSize: e.fileSize.toString(),
      crc32: e.crc32.toLowerCase(),
      md5: e.md5.toLowerCase(),
      sha1: e.sha1.toLowerCase(),

      details: {
        hackName: sub?.hackName ?? e.machineName,
        version: sub?.version ?? '',
        versionChangelog: sub?.versionChangelog ?? null,
        translationLanguages: sub?.translationLanguages ?? [],
        author: sub?.author ?? null,
        releaseYear: sub?.releaseYear ?? null,
        releaseDate: toISODateOnly(sub?.releaseDate),
        description: sub?.description ?? null,
        tags: sub?.tags.map((st) => ({ slug: st.tag.slug, name: st.tag.name })) ?? [],

        hackFamily: sub?.hackFamily
          ? {
              name: sub.hackFamily.name,
              author: sub.hackFamily.author,
              releaseYear: sub.hackFamily.releaseYear,
              releaseDate: toISODateOnly(sub.hackFamily.releaseDate),
              description: sub.hackFamily.description,
            }
          : null,

        patch: {
          type: sub?.patchType ?? null,
          filename: sub?.patchFilename ?? null,
          sha1: sub?.patchSha1 ?? null,
        },
        baseRom: sub?.baseRom
          ? {
              name: sub.baseRom.name,
              platform: sub.baseRom.platform,
              crc32: sub.baseRom.crc32,
              md5: sub.baseRom.md5,
              sha1: sub.baseRom.sha1,
              status: sub.baseRom.status,
            }
          : null,

        sourceUrl: sub?.sourceUrl ?? null,
        releasePageUrl: sub?.releasePageUrl ?? null,
        githubUrl: sub?.githubUrl ?? null,
        notes: sub?.notes ?? null,

        gameDatabaseLinks: m
          ? {
              canonicalName: m.canonicalName ?? null,
              igdb: { id: clean('igdbId', m.igdbId), slug: m.igdbSlug ?? null },
              theGamesDB: clean('theGamesDBId', m.theGamesDBId),
              launchbox: clean('launchboxId', m.launchboxId),
              giantBomb: clean('giantBombId', m.giantBombId),
              screenScraper: clean('screenScraperId', m.screenScraperId),
              steamGridDB: clean('steamGridDBId', m.steamGridDBId),
              retroAchievements: clean('retroAchievementsId', m.retroAchievementsId),
              steam: clean('steamId', m.steamId),
              gog: clean('gogId', m.gogId),
              epicGames: clean('epicGamesId', m.epicGamesId),
              wikipedia: clean('wikipediaUrl', m.wikipediaUrl),
              hasheousId: m.hasheousId ?? null,
            }
          : null,

        approvedAt: e.approvedAt.toISOString(),
      },
    };
  });
}

// ─── Export Filenames ──────────────────────────────────────────────────────────
//
// Format: "{Platform} - RomHacks - HackHash - {Date} {Time}[.ext]"
// e.g. "SNES - RomHacks - HackHash - 2026-07-09 1847.dat"
// Used by both the single-file export route and the all-platforms zip route,
// so a naming change only ever needs to happen in one place.

function sanitizeForFilename(s: string): string {
  // Strip characters invalid in a filename on Windows (a couple of platform
  // labels contain "/", e.g. "Genesis / Mega Drive") plus any control
  // characters (CR/LF etc) — defensive, since this value can trace back to
  // a query param and ends up inside a response header.
  return s
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/[\/\\:*?"<>|]/g, '-')
    .replace(/\s*-\s*-\s*/g, ' - ')
    .trim();
}

function formatDateTimeForFilename(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function buildExportFilenameBase(
  platform: string | undefined,
  format: 'xml' | 'json' | 'csv' | 'detailed',
  when: Date = new Date()
): string {
  const platformLabel = platform ? (PLATFORM_LABELS as Record<string, string>)[platform] ?? platform : 'All Platforms';
  const safeLabel = sanitizeForFilename(platformLabel);
  // "Detailed" needs to be distinguishable from the lean JSON export, since
  // both use a .json extension and would otherwise produce an identical
  // filename for the same platform.
  const detailedSegment = format === 'detailed' ? ' - Detailed' : '';
  return `${safeLabel} - RomHacks - HackHash${detailedSegment} - ${formatDateTimeForFilename(when)}`;
}

export function extensionForFormat(format: 'xml' | 'json' | 'csv' | 'detailed'): string {
  return format === 'xml' ? 'dat' : format === 'csv' ? 'csv' : 'json';
}

// ─── Fetch header settings ────────────────────────────────────────────────────

export async function getDATHeader(platform?: string): Promise<DATHeader> {
  const settings = await prisma.siteSetting.findMany({
    where: { key: { in: ['dat_name', 'dat_description', 'dat_url', 'dat_author'] } },
  });

  const map = Object.fromEntries(settings.map((s) => [s.key, s.value]));
  const baseName = map['dat_name'] ?? 'HackHash Community';
  const baseDescription = map['dat_description'] ?? 'Community-driven ROM Hack database';

  return {
    name: platform ? `${baseName} (${platform})` : baseName,
    description: platform ? `${baseDescription} — ${platform} only` : baseDescription,
    version: new Date().toISOString().split('T')[0].replace(/-/g, ''),
    date: new Date().toISOString().split('T')[0],
    author: map['dat_author'] ?? 'HackHash Community',
    // Deployment-specific fallback — only used if the dat_url SiteSetting
    // row is missing from the database entirely (not just empty). If you're
    // self-hosting your own instance of this project, set your own dat_url
    // setting rather than relying on this default.
    url: map['dat_url'] ?? 'https://hackhash.darkblood.uk',
  };
}

// ─── XML Generation ───────────────────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function generateDATXML(header: DATHeader, machines: DATMachine[]): string {
  const machineBlocks = machines
    .map(
      (m) => `\t<machine name="${escapeXml(m.machineName)}">
\t\t<description>${escapeXml(m.description)}</description>
\t\t<rom
\t\t\tname="${escapeXml(m.romName)}"
\t\t\tsize="${m.fileSize}"
\t\t\tcrc="${m.crc32}"
\t\t\tmd5="${m.md5}"
\t\t\tsha1="${m.sha1}"
\t\t/>
\t</machine>`
    )
    .join('\n');

  return `<?xml version="1.0"?>
<!DOCTYPE datafile PUBLIC "-//Logiqx//DTD ROM Management Datafile//EN"
  "http://www.logiqx.com/Docs/No-Intro/datfiles.dtd">
<datafile>
\t<header>
\t\t<name>${escapeXml(header.name)}</name>
\t\t<description>${escapeXml(header.description)}</description>
\t\t<version>${header.version}</version>
\t\t<date>${header.date}</date>
\t\t<author>${escapeXml(header.author)}</author>
\t\t<url>${escapeXml(header.url)}</url>
\t</header>
${machineBlocks}
</datafile>`;
}

// ─── JSON Generation ──────────────────────────────────────────────────────────

export function generateDATJSON(header: DATHeader, machines: DATMachine[]): string {
  return JSON.stringify(
    {
      header,
      machines: machines.map((m) => ({
        machineName: m.machineName,
        description: m.description,
        rom: {
          name: m.romName,
          size: m.fileSize,
          crc: m.crc32,
          md5: m.md5,
          sha1: m.sha1,
        },
      })),
      generated: new Date().toISOString(),
      count: machines.length,
    },
    null,
    2
  );
}

// ─── Detailed JSON Generation ─────────────────────────────────────────────────

export function generateDetailedJSON(
  header: DATHeader,
  entries: DetailedEntry[],
  dismissedDuplicates: DismissedPairExport[] = []
): string {
  return JSON.stringify(
    {
      header,
      // Named "machines" — not "entries" — deliberately: this is what
      // src/lib/dat-parser.ts looks for when someone re-uploads this file
      // through the import form, same key the lean JSON export uses. Do
      // NOT rename this without also updating dat-parser.ts's parseDatJson,
      // or detailed exports silently become un-importable again.
      machines: entries,
      // Confirmed "not a duplicate" decisions (src/lib/hackFamily.ts),
      // included so a database rebuild from this file doesn't lose that
      // work and force re-reviewing the same pairs — see
      // extractDismissedDuplicates() in dat-parser.ts and POST
      // /api/admin/hack-families/import-dismissals for the import side.
      // Omitted entirely (not an empty array) when there's nothing to
      // report, so exports from projects with no dismissals stay clean.
      ...(dismissedDuplicates.length > 0 ? { dismissedDuplicates } : {}),
      generated: new Date().toISOString(),
      count: entries.length,
    },
    null,
    2
  );
}

// ─── CSV Generation ───────────────────────────────────────────────────────────

function csvEscape(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

export function generateDATCSV(machines: DATMachine[]): string {
  const headers = ['Machine Name', 'Description', 'ROM Name', 'Size', 'CRC32', 'MD5', 'SHA1'];
  const rows = machines.map((m) =>
    [m.machineName, m.description, m.romName, m.fileSize, m.crc32, m.md5, m.sha1]
      .map(csvEscape)
      .join(',')
  );

  return [headers.join(','), ...rows].join('\n');
}

// ─── Single entry XML snippet ─────────────────────────────────────────────────

export function generateEntryXML(machine: DATMachine): string {
  return `<machine name="${escapeXml(machine.machineName)}">
    <description>${escapeXml(machine.description)}</description>
    <rom
        name="${escapeXml(machine.romName)}"
        size="${machine.fileSize}"
        crc="${machine.crc32}"
        md5="${machine.md5}"
        sha1="${machine.sha1}"
    />
</machine>`;
}
