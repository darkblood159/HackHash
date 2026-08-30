// src/lib/filenameParser.ts
//
// Best-effort extraction of a hack name + version from an uploaded ROM's
// filename, used to prefill the submit form (src/components/SubmitForm.tsx)
// — never authoritative, the submitter can always edit the result. Raw
// filenames have no real standard (unlike DAT machine names, which are
// already clean, curated text — see splitNameVersion in dat-parser.ts,
// which this deliberately does NOT share code with, since filenames need
// to handle underscores-as-spaces and version markers with no parentheses
// at all, neither of which a curated DAT name needs to worry about).

const ROM_EXTENSIONS = [
  'smc', 'sfc', 'fig', 'nes', 'fds', 'gb', 'gbc', 'gba', 'n64', 'z64', 'v64',
  'gen', 'md', 'smd', 'sms', 'gg', 'pce', 'ngp', 'ngc', 'ws', 'wsc',
  'iso', 'bin', 'cue', 'gdi', 'chd', '32x', 'a26', 'a52', 'a78',
  'ips', 'bps', 'ups', 'xdelta', 'ppf', 'aps',
  'zip', '7z', 'rar',
];

function stripKnownExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  if (idx <= 0) return filename;
  const ext = filename.slice(idx + 1).toLowerCase();
  return ROM_EXTENSIONS.includes(ext) ? filename.slice(0, idx) : filename;
}

// Three patterns, tried in order — same "trust an explicit v/version prefix
// for anything that follows" idea as dat-parser.ts's splitNameVersion, plus
// a third pattern that one doesn't need: a trailing version marker with NO
// parentheses at all ("Hack_Name_v1.2", "Hack Name - v1.2"), common in raw
// filenames but not something a curated DAT machine name needs.
const VERSION_PARENS_PREFIXED = /^(.*?)\s*\(\s*v(?:ersion)?\.?\s*([^)]+?)\s*\)\s*$/i;
const VERSION_PARENS_BARE = /^(.*?)\s*\(\s*([\d][\d.]*[a-zA-Z]*)\s*\)\s*$/;
const VERSION_TRAILING_BARE = /^(.*?)[\s_-]+v(?:ersion)?\.?\s*([\d][\d.]*[a-zA-Z]*)$/i;

export interface ParsedFilename {
  hackName: string;
  version?: string;
}

export function parseRomFilename(filename: string): ParsedFilename {
  const cleaned = stripKnownExtension(filename)
    .replace(/_/g, ' ')
    .replace(/\s*-\s*/g, ' - ') // normalize spacing around hyphen-separators, don't touch word-internal ones differently
    .replace(/\s+/g, ' ')
    .trim();

  const parensPrefixed = cleaned.match(VERSION_PARENS_PREFIXED);
  if (parensPrefixed && parensPrefixed[1].trim() && parensPrefixed[2].trim()) {
    return { hackName: parensPrefixed[1].trim(), version: parensPrefixed[2].trim() };
  }

  const parensBare = cleaned.match(VERSION_PARENS_BARE);
  if (parensBare && parensBare[1].trim()) {
    return { hackName: parensBare[1].trim(), version: parensBare[2].trim() };
  }

  const trailingBare = cleaned.match(VERSION_TRAILING_BARE);
  if (trailingBare && trailingBare[1].trim()) {
    return { hackName: trailingBare[1].replace(/[\s-]+$/, '').trim(), version: trailingBare[2].trim() };
  }

  return { hackName: cleaned };
}
