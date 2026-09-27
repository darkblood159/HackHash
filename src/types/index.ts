// src/types/index.ts
export type { Platform } from '@prisma/client';

// ─── Platform / console ───────────────────────────────────────────────────────

export const PLATFORMS = [
  // A
  'AMIGA',       // Amiga
  'ARCADE',      // Arcade
  'ATARI2600',   // Atari 2600
  'ATARI7800',   // Atari 7800
  'JAGUAR',      // Atari Jaguar
  'LYNX',        // Atari Lynx
  // C
  'C64',         // Commodore 64
  // D
  'DOS',         // DOS
  'DC',          // Dreamcast
  // G
  'GB',          // Game Boy
  'GBA',         // Game Boy Advance
  'GBC',         // Game Boy Color
  'GG',          // Game Gear
  'GCN',         // GameCube
  'GENESIS',     // Genesis / Mega Drive
  // M
  'SMS',         // Master System
  // N
  'NEOGEO',      // Neo Geo
  'NGPC',        // Neo Geo Pocket Color
  'NES',         // NES
  'N3DS',        // Nintendo 3DS
  'N64',         // Nintendo 64
  'NDS',         // Nintendo DS
  // O
  'OTHER',       // Other
  // P
  'PCENGINE',    // PC Engine / TurboGrafx-16
  'PC88',        // PC-88
  'PC98',        // PC-98
  'PS1',         // PlayStation
  'PS2',         // PlayStation 2
  'PS3',         // PlayStation 3
  'PSVITA',      // PS Vita
  'PSP',         // PSP
  // S
  'SAT',         // Saturn
  'S32X',        // Sega 32X
  'SCD',         // Sega CD / Mega-CD
  'SNES',        // SNES
  'SWITCH',      // Switch
  // V
  'VIRTUALBOY',  // Virtual Boy
  // W
  'WII',         // Wii
  'WIIU',        // Wii U
  'WINDOWS',     // Windows
  // X
  'XBOX',        // Xbox
  'XBOX360',     // Xbox 360
] as const;
export type PlatformValue = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<PlatformValue, string> = {
  // Nintendo handhelds
  GB: 'Game Boy',
  GBC: 'Game Boy Color',
  GBA: 'Game Boy Advance',
  NDS: 'Nintendo DS',
  N3DS: 'Nintendo 3DS',
  // Nintendo home consoles
  NES: 'NES',
  SNES: 'SNES',
  N64: 'Nintendo 64',
  GCN: 'GameCube',
  WII: 'Wii',
  WIIU: 'Wii U',
  SWITCH: 'Switch',
  // Nintendo portables (older)
  VIRTUALBOY: 'Virtual Boy',
  // Sega handhelds
  GG: 'Game Gear',
  // Sega home consoles
  SMS: 'Master System',
  GENESIS: 'Genesis / Mega Drive',
  SCD: 'Sega CD / Mega-CD',
  S32X: 'Sega 32X',
  SAT: 'Saturn',
  DC: 'Dreamcast',
  // Sony handhelds
  PSP: 'PSP',
  PSVITA: 'PS Vita',
  // Sony home consoles
  PS1: 'PlayStation',
  PS2: 'PlayStation 2',
  PS3: 'PlayStation 3',
  // Microsoft
  XBOX: 'Xbox',
  XBOX360: 'Xbox 360',
  // Atari
  ATARI2600: 'Atari 2600',
  ATARI7800: 'Atari 7800',
  JAGUAR: 'Atari Jaguar',
  LYNX: 'Atari Lynx',
  // SNK
  NEOGEO: 'Neo Geo',
  NGPC: 'Neo Geo Pocket Color',
  // NEC
  PCENGINE: 'PC Engine / TurboGrafx-16',
  PC88: 'PC-88',
  PC98: 'PC-98',
  // Commodore / Home computers
  C64: 'Commodore 64',
  AMIGA: 'Amiga',
  // Arcade
  ARCADE: 'Arcade',
  // PC
  DOS: 'DOS',
  WINDOWS: 'Windows',
  // Other
  OTHER: 'Other',
};

// ─── ROM File Info (browser-side only) ───────────────────────────────────────

export interface ROMFileInfo {
  filename: string;
  fileSize: number;
  crc32: string;
  md5: string;
  sha1: string;
  processing: boolean;
  progress: number | null; // null = in progress, no known percent (7z/RAR extraction has no percent-complete callback at all — see src/lib/archiveExtract.ts). Never null once processing is false.
  error?: string;
  // Both new, optional, additive — set when this file came from inside an
  // archive (src/lib/archiveExtract.ts) rather than being hashed directly.
  // `filename`/`fileSize` above already describe the extracted ROM itself
  // (never the archive), so every existing consumer works unchanged;
  // these two only drive purely-cosmetic "extracted from" UI and the
  // in-progress phase label in ROMProcessor.tsx.
  sourceArchiveName?: string;
  phase?: 'loading' | 'extracting' | 'hashing'; // 'loading' = fetching/starting the archive reader itself (currently only 7z/RAR — jszip and gzip's DecompressionStream are both already-bundled, so there's nothing to separately "load" for those)
}

// ─── Trust system ─────────────────────────────────────────────────────────────

// Single source of truth for trust tier thresholds — these used to be
// hardcoded separately in 7 different files (trust.ts, approval.ts,
// TrustBadge, VerifyPanel, UserActionMenu, verify route, the trust-system
// docs page), which is exactly how a threshold change request like "raise
// these" turns into a half-applied bug. Import from here everywhere instead.
export const TRUST_TIER_THRESHOLDS = {
  TRUSTED: 200,
  VETERAN: 700,
} as const;

