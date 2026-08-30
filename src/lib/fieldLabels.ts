// src/lib/fieldLabels.ts
//
// Single source of truth for "what does this API field name mean to a
// human" — previously duplicated separately in ChangeRequestSection.tsx
// and admin/change-requests/page.tsx (the latter a genuine subset of the
// former, already drifted: missing versionChangelog, patchType/
// patchFilename/patchSha1, baseRomId, and every game-database ID field).
// Same "two hand-maintained copies that could drift" shape this project
// has hit before for tags and mapping-field strippers — centralizing here
// rather than leaving a third near-copy to maintain for the validation-
// error display work below.

export const FIELD_LABELS: Record<string, string> = {
  hackName: 'Hack name',
  version: 'Version',
  author: 'Author',
  releaseYear: 'Release year',
  releaseDate: 'Release date',
  description: 'Description',
  versionChangelog: 'Version changelog',
  sourceUrl: 'Source URL',
  platform: 'Platform',
  notes: 'Notes',
  releasePageUrl: 'Release page',
  githubUrl: 'GitHub URL',
  patchType: 'Patch type',
  patchFilename: 'Patch filename',
  patchSha1: 'Patch SHA-1',
  baseRomId: 'Base ROM',
  filename: 'ROM filename',
  fileSize: 'File size',
  crc32: 'CRC32',
  md5: 'MD5',
  sha1: 'SHA-1',
  tags: 'Tags',
  translationLanguages: 'Translated languages',
  igdbId: 'IGDB', theGamesDBId: 'TheGamesDB', launchboxId: 'LaunchBox', steamGridDBId: 'SteamGridDB',
  retroAchievementsId: 'RetroAchievements', steamId: 'Steam', gogId: 'GOG.com', giantBombId: 'Giant Bomb',
  screenScraperId: 'ScreenScraper', epicGamesId: 'Epic Games', wikipediaUrl: 'Wikipedia',
};

/** camelCase -> "Camel case" fallback for any field this map hasn't caught up with yet. */
function humanizeFieldKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** Zod's own message text can occasionally run long (e.g. a big enum's full value list) — trimmed defensively so one field's error can't dominate the whole banner. */
function truncateMessage(msg: string, max = 160): string {
  return msg.length > max ? `${msg.slice(0, max)}…` : msg;
}

/**
 * Turns a Zod `flatten()` result (or the API response shape it usually
 * arrives in) into a short, user-facing message — one line if there's a
 * single problem, a bulleted list if there's more than one. Returns null
 * if there's nothing to describe, so callers can cleanly fall back to a
 * generic message.
 *
 * Deliberately shows Zod's own message text (e.g. "String must contain at
 * most 3000 character(s)") rather than trying to rewrite every possible
 * validation rule into custom copy — that message is already clear for
 * the overwhelming majority of cases (min/max length, invalid URL,
 * invalid format), and reinventing it per-rule would be a lot of surface
 * area to maintain for not much clarity gained. The one defensive
 * exception is truncateMessage() above, for the rarer enum-dump case.
 */
export function describeValidationError(
  details: { formErrors?: string[]; fieldErrors?: Record<string, string[] | undefined> } | null | undefined
): string | null {
  if (!details) return null;
  const lines: string[] = [];

  for (const msg of details.formErrors ?? []) {
    lines.push(truncateMessage(msg));
  }
  for (const [field, msgs] of Object.entries(details.fieldErrors ?? {})) {
    if (!msgs?.length) continue;
    const label = FIELD_LABELS[field] ?? humanizeFieldKey(field);
    for (const msg of msgs) {
      lines.push(`${label}: ${truncateMessage(msg)}`);
    }
  }

  if (lines.length === 0) return null;
  if (lines.length === 1) return lines[0];
  return `Please fix the following:\n${lines.map((l) => `• ${l}`).join('\n')}`;
}
