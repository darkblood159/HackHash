// src/lib/romExtensions.ts
//
// A best-effort list of file extensions that represent an actual ROM/disc
// image, as opposed to a patch, readme, or other non-ROM file that might
// sit alongside one inside an archive. Used ONLY by src/lib/archiveExtract.ts
// to guess which file inside an extracted .zip is "the ROM" when there's
// more than one candidate — it is deliberately NOT used to restrict what
// can be hashed directly. A raw, non-archive upload is always accepted
// regardless of extension (see ROMProcessor.tsx), since this project
// supports far too many platforms/formats to safely allow-list direct
// uploads, and this list doesn't try to be that authority either.
//
// Loosely grouped by platform family for anyone extending it later, but
// intentionally NOT keyed to the Platform enum (src/types/index.ts) — a
// lot of these extensions are legitimately ambiguous across multiple
// platforms (.bin/.iso/.chd especially), and this list only ever needs to
// answer "does this look like a ROM at all", not "which platform".
//
// Not exhaustive. If a real submission's archive ever gets stuck asking
// the submitter to pick between files because its actual ROM extension
// isn't here yet, that's a sign to add it — same "additive, grows with
// real use" spirit as src/lib/languages.ts and src/lib/tags.ts.

export const ROM_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  // Nintendo handhelds
  'gb', 'gbc', 'sgb',                    // Game Boy / Color
  'gba', 'agb',                          // Game Boy Advance
  'nds', 'dsi', 'ids', 'srl',            // Nintendo DS
  '3ds', 'cia', 'cci', 'cxi', '3dsx',    // Nintendo 3DS
  // Nintendo home consoles
  'nes', 'unf', 'unif', 'fds',           // NES / Famicom Disk System
  'smc', 'sfc', 'fig', 'swc', 'bs',      // SNES
  'n64', 'z64', 'v64', 'ndd',            // Nintendo 64
  'gcm', 'rvz', 'gcz',                   // GameCube
  'wbfs', 'wad', 'wdf',                  // Wii
  'wud', 'wux', 'rpx',                   // Wii U
  'nsp', 'xci', 'nca',                   // Switch
  'vb', 'vboy',                          // Virtual Boy
  // Sega
  'gen', 'smd', '32x',                   // Genesis / Mega Drive / 32X
  // NOTE: '.md' is deliberately NOT listed here even though it's a real,
  // if less common, Genesis/Mega Drive ROM extension (interchangeable with
  // .bin in some tools/archives) — it collides with '.md' as Markdown,
  // which is listed in KNOWN_NON_ROM_EXTENSIONS below and is FAR more
  // likely to appear in a real submission archive on this site (a hack's
  // README.md, changelog, etc.), across every platform, not just Genesis.
  // Keeping '.md' out of this set means the common "ROM + readme.md" case
  // auto-picks correctly instead of unnecessarily falling through to the
  // manual picker; a genuine Genesis .md ROM still resolves correctly via
  // pickAutoCandidate's tier 2/3 (or the manual picker as a safe
  // fallback) — it just no longer wins tier 1 on extension alone.
  'sms',                                 // Master System
  'gg',                                  // Game Gear
  'gdi', 'cdi',                          // Dreamcast / Saturn
  // Sony
  'pbp', 'ecm', 'cso',                   // PS1 / PSP-friendly disc formats
  'vpk',                                 // PS Vita
  // Microsoft
  'xbe', 'xex', 'god',                   // Xbox / Xbox 360
  // Generic disc-image containers — shared across many platforms above
  // (PS1/PS2/PS3/Saturn/Dreamcast/Sega CD/GameCube/Wii/Xbox all commonly
  // use one or more of these, which is exactly why they're generic):
  'iso', 'bin', 'cue', 'chd', 'mdf', 'nrg', 'img',
  // SNK
  'neo',                                 // Neo Geo
  'ngp', 'ngc',                          // Neo Geo Pocket (Color)
  // NEC
  'pce',                                 // PC Engine / TurboGrafx-16
  'd88', 'hdi', 'tfi', 'fdi', '2d', 'hdm', 'xdf', // PC-88 / PC-98
  // Atari
  'a26',                                 // Atari 2600
  'a78',                                 // Atari 7800
  'j64', 'jag', 'abs', 'cof',            // Atari Jaguar
  'lnx',                                 // Atari Lynx
  // Commodore / home computers
  'd64', 't64', 'prg', 'crt',            // Commodore 64
  'adf', 'dms', 'ipf', 'hdf',            // Amiga
  // PC (DOS / Windows) — genuinely generic, but these platforms exist in
  // PLATFORMS (src/types/index.ts) and an archive is the NORMAL way a DOS
  // game gets distributed, unlike most of the list above.
  'exe', 'com',
]);

// Files that commonly ride along with a ROM in a release archive, but are
// never themselves the thing being hashed. Used to sharpen the "exactly
// one plausible candidate" fallback in archiveExtract.ts when nothing
// matches ROM_FILE_EXTENSIONS above (e.g. a hack using an extension this
// list doesn't know about yet, sitting next to a readme) — NOT used to
// hide anything from the manual picker, where every real file is always
// shown regardless.
const KNOWN_NON_ROM_EXTENSIONS: ReadonlySet<string> = new Set([
  // Patches — the whole point of a "hack", but never what gets hashed here.
  'ips', 'bps', 'ups', 'xdelta', 'ppf', 'aps',
  // Docs / metadata.
  'txt', 'nfo', 'md', 'pdf', 'doc', 'docx', 'diz', 'url',
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp',
]);

function extensionOf(filename: string): string | null {
  const idx = filename.lastIndexOf('.');
  if (idx <= 0) return null;
  return filename.slice(idx + 1).toLowerCase();
}

export function looksLikeRomFile(filename: string): boolean {
  const ext = extensionOf(filename);
  return !!ext && ROM_FILE_EXTENSIONS.has(ext);
}

export function looksLikeKnownNonRomFile(filename: string): boolean {
  const ext = extensionOf(filename);
  return !!ext && KNOWN_NON_ROM_EXTENSIONS.has(ext);
}
