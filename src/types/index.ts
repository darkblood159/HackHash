// src/types/index.ts
export type { UserRole, SubmissionStatus, PatchType, DuplicateType, TrustEventType, Platform } from '@prisma/client';

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
  progress: number;
  error?: string;
}

// ─── Submission ───────────────────────────────────────────────────────────────

export interface SubmissionFormData {
  hackName: string;
  version: string;
  description?: string;
  author?: string;
  releaseYear?: number;
  // ISO 'YYYY-MM-DD', when the exact date is known — releaseYear above
  // remains the year-only fallback, see prisma/schema.prisma's comment on
  // Submission.releaseDate for why these are separate, additive fields.
  releaseDate?: string;
  platform: string;
  sourceUrl: string;
  filename: string;
  fileSize: number;
  crc32: string;
  md5: string;
  sha1: string;
  patchType?: string;
  patchFilename?: string;
  patchSha1?: string;
  notes?: string;
  releasePageUrl?: string;
  githubUrl?: string;
  tags?: string[];
}

export interface SubmissionWithRelations {
  id: string;
  hackName: string;
  version: string;
  description: string | null;
  author: string | null;
  releaseYear: number | null;
  releaseDate: string | Date | null;
  platform: string;
  sourceUrl: string | null;
  filename: string;
  fileSize: bigint | string;
  crc32: string;
  md5: string;
  sha1: string;
  patchType: string | null;
  patchFilename: string | null;
  patchSha1: string | null;
  notes: string | null;
  releasePageUrl: string | null;
  githubUrl: string | null;
  status: string;
  verificationScore: number;
  createdAt: string | Date;
  updatedAt: string | Date;
  submittedBy: {
    id: string;
    name: string | null;
    image: string | null;
    username: string | null;
    trustScore: number;
  };
  verifications: VerificationWithUser[];
  screenshots: Screenshot[];
  tags: Array<{ tag: { id: string; name: string; slug: string; description: string | null } }>;
  translationLanguages: string[];
  _count?: {
    verifications: number;
    comments: number;
  };
}

export interface VerificationWithUser {
  id: string;
  matches: boolean;
  isManualVote: boolean;
  sha1Matched: boolean | null;
  md5Matched: boolean | null;
  crc32Matched: boolean | null;
  notes: string | null;
  weight: number;
  createdAt: string | Date;
  user: {
    id: string;
    name: string | null;
    image: string | null;
    username: string | null;
    trustScore: number;
    role: string;
  };
}

export interface Screenshot {
  id: string;
  url: string;
  caption: string | null;
}

// ─── Approved Entry ───────────────────────────────────────────────────────────

export interface ApprovedEntryWithSubmission {
  id: string;
  machineName: string;
  description: string;
  romName: string;
  fileSize: bigint | string;
  crc32: string;
  md5: string;
  sha1: string;
  datVersion: string;
  approvedAt: string | Date;
  submission: {
    id: string;
    hackName: string;
    author: string;
    submittedBy: { name: string | null; username: string | null };
  };
}

// ─── User Profile ─────────────────────────────────────────────────────────────

export interface UserProfile {
  id: string;
  name: string | null;
  email?: string | null;
  image: string | null;
  username: string | null;
  bio: string | null;
  role: string;
  trustScore: number;
  isBanned: boolean;
  createdAt: string | Date;
  _count: {
    submissions: number;
    verifications: number;
  };
  trustEvents: TrustEvent[];
}

export interface TrustEvent {
  id: string;
  eventType: string;
  delta: number;
  reason: string;
  createdAt: string | Date;
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

export interface AuditLogEntry {
  id: string;
  action: string;
  details: Record<string, unknown>;
  createdAt: string | Date;
  user: {
    id: string;
    name: string | null;
    username: string | null;
  } | null;
}

// ─── DAT Export ───────────────────────────────────────────────────────────────

export interface DATEntry {
  machineName: string;
  description: string;
  romName: string;
  fileSize: string;
  crc32: string;
  md5: string;
  sha1: string;
}

// ─── API Responses ────────────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
}

// ─── Trust system ─────────────────────────────────────────────────────────────

export const TRUST_WEIGHTS = {
  CONTRIBUTOR: 1,    // below TRUSTED threshold
  TRUSTED: 3,        // TRUSTED_THRESHOLD - VETERAN_THRESHOLD
  VETERAN: 10,       // VETERAN_THRESHOLD+
} as const;

// Single source of truth for trust tier thresholds — these used to be
// hardcoded separately in 7 different files (trust.ts, approval.ts,
// TrustBadge, VerifyPanel, UserActionMenu, verify route, the trust-system
// docs page), which is exactly how a threshold change request like "raise
// these" turns into a half-applied bug. Import from here everywhere instead.
export const TRUST_TIER_THRESHOLDS = {
  TRUSTED: 200,
  VETERAN: 700,
} as const;

export const TRUST_DELTAS = {
  SUBMISSION_APPROVED: 10,
  SUBMISSION_REJECTED: -10,
  CORRECT_VERIFICATION: 2,
  FALSE_VERIFICATION: -5,
  DUPLICATE_FOUND: 5,
  SPAM: -20,
  ABUSE: -30,
} as const;

export const STATUS_THRESHOLDS = {
  COMMUNITY_VERIFIED: 5,
  RECOMMENDED: 15,
} as const;
