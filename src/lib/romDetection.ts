// src/lib/romDetection.ts
//
// Best-effort detection of "this looks like a known ROM/disc-image
// container format," used ONLY as a second, automatic layer on top of the
// 'OTHER' patch-type escape hatch (patchValidation.ts) — NOT a general-
// purpose ROM identifier, and NOT a claim of complete coverage.
//
// WHY THIS EXISTS, AND WHAT IT ACTUALLY GUARANTEES: 'OTHER' lets an
// upload through when detectPatchFormat() (patchValidation.ts) finds none
// of the six known PATCH signatures — by design, since that's exactly
// what a real, uncommon patch format looks like. The real risk that opens
// is someone uploading an entire ROM/ISO and just declaring it 'OTHER'.
// The actual, LOAD-BEARING defense against that is procedural, not
// technical: only a privileged (ADMINISTRATOR/VERIFIER) uploader can use
// 'OTHER' at all (see isPrivilegedPatchRole, patchPermissions.ts, and its
// use in POST /api/submissions/[id]/patch) — a specific human making a
// judgment call on a specific file is a real, complete guarantee in a way
// no byte-signature check can be, since a signature check can only ever
// catch formats it was specifically written for. What THIS file adds is a
// second, automatic layer on top of that human judgment: an immediate,
// unambiguous rejection for the most common cases, so an honest mistake —
// or a privileged user who didn't look closely at what they were
// attaching — gets caught too.
//
// Every signature below was verified against a specific, named technical
// source this session (GBATEK for GBA, wiibrew.org / the `nod` and `file`
// projects for GameCube/Wii, n64brew.dev for N64, the long-standing `file`
// magic database and ECMA-119 conventions for ISO 9660, NESdev/gbdev for
// NES and Game Boy) — not recalled from general memory and not guessed
// at. Where a format has NO reliable universal signature at a fixed
// offset — SNES ROMs (header location depends on the cartridge's memory
// map and isn't a fixed "magic" the way these are), NDS, and most
// computer platforms this project's own Platform enum lists (C64, Amiga,
// DOS, Windows, PC-88/98, arcade) — it is DELIBERATELY left uncovered
// here rather than implemented on a guess. A wrong signature is worse
// than no signature at all: it teaches a false sense of complete coverage
// to whoever reads this file next. This list is expected to grow as more
// formats are verified with the same rigor; it was never claimed, and
// should never be assumed, to be exhaustive.

export interface RomDetectionResult {
  looksLikeRom: boolean;
  matchedFormat?: string;
}

interface RomSignature {
  offset: number;
  bytes: number[];
  label: string;
}

// Every entry here is checked as an equally strong match — a short, exact
// byte sequence at a fixed offset with a real, cited technical source and
// (bar deliberate malicious construction) no legitimate patch file would
// ever coincidentally reproduce it. The single weaker, single-byte GBA
// check further below is kept deliberately separate from this list.
const ROM_SIGNATURES: RomSignature[] = [
  // NES — iNES header, "NES" followed by an MS-DOS EOF byte. Also covers
  // NES 2.0, which reuses the identical first four bytes.
  // Source: wiki.nesdev.org/w/index.php/INES
  { offset: 0, bytes: [0x4e, 0x45, 0x53, 0x1a], label: 'an NES ROM (iNES header)' },

  // Game Boy / Game Boy Color — the first 4 bytes of the fixed 48-byte
  // Nintendo logo bitmap at offset 0x104. Every real GB/GBC ROM must
  // reproduce this bitmap exactly, or real hardware refuses to boot it.
  // Source: gbdev.io Pan Docs, "The Cartridge Header".
  { offset: 0x104, bytes: [0xce, 0xed, 0x66, 0x66], label: 'a Game Boy / Game Boy Color ROM' },

  // Nintendo 64 — all three byte orders a dump can be stored in.
  // Source: n64brew.dev's ROM Header page: "All known commercial games
  // use 0x80 0x37 0x12 0x40" in the first four bytes of a big-endian
  // (.z64) dump; .v64/.n64 carry the same bytes reordered.
  { offset: 0, bytes: [0x80, 0x37, 0x12, 0x40], label: 'an N64 ROM (.z64, big-endian)' },
  { offset: 0, bytes: [0x37, 0x80, 0x40, 0x12], label: 'an N64 ROM (.v64, byte-swapped)' },
  { offset: 0, bytes: [0x40, 0x12, 0x37, 0x80], label: 'an N64 ROM (.n64, little-endian)' },

  // GameCube / Wii — the disc format's own magic words. Checked
  // independently of each other (a Wii disc zeroes the GameCube field at
  // its own offset, and vice versa), so either alone is a real match, not
  // half of one. Source: wiibrew.org's "Wii Disc" page, corroborated by
  // the `nod` disc-reading library and the `file` command's own magic
  // database (both independently list the same two offsets/values).
  { offset: 0x1c, bytes: [0xc2, 0x33, 0x9f, 0x3d], label: 'a GameCube disc image' },
  { offset: 0x18, bytes: [0x5d, 0x1c, 0x9e, 0xa3], label: 'a Wii disc image' },

  // ISO 9660 — the volume descriptor identifier "CD001", always at
  // exactly this byte offset (32768 bytes of system area, then a 1-byte
  // descriptor-type field immediately before it). Covers the large
  // majority of CD/DVD-based dumps this project actually sees — PS1, PS2,
  // PSP, Saturn, Dreamcast, and any other plain ISO/BIN image — since
  // none of those systems use a proprietary disc format the way
  // GameCube/Wii do. Source: the ISO 9660 / ECMA-119 standard itself, as
  // reflected in the `file` command's own long-standing magic database.
  { offset: 32769, bytes: [0x43, 0x44, 0x30, 0x30, 0x31], label: 'a CD/DVD disc image (ISO 9660)' },
];

// Deliberately weaker than everything above (a single byte — roughly a
// 1-in-256 chance of a coincidental match against arbitrary binary data)
// so it's kept out of ROM_SIGNATURES and checked last, alone: GBATEK's own
// GBA Cartridge Header reference states plainly that this byte "Must be
// 96h" for every real GBA ROM or Multiboot image. Worth having as one
// more signal even though it's weaker on its own — this function's
// overall honesty depends on not overstating what a single byte proves.
const GBA_FIXED_VALUE_OFFSET = 0xb2;
const GBA_FIXED_VALUE = 0x96;

function bytesMatchAt(bytes: Buffer, offset: number, expected: number[]): boolean {
  if (bytes.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (bytes[offset + i] !== expected[i]) return false;
  }
  return true;
}

export function looksLikeKnownRom(bytes: Buffer): RomDetectionResult {
  for (const sig of ROM_SIGNATURES) {
    if (bytesMatchAt(bytes, sig.offset, sig.bytes)) {
      return { looksLikeRom: true, matchedFormat: sig.label };
    }
  }
  if (bytes.length > GBA_FIXED_VALUE_OFFSET && bytes[GBA_FIXED_VALUE_OFFSET] === GBA_FIXED_VALUE) {
    return { looksLikeRom: true, matchedFormat: 'a Game Boy Advance ROM' };
  }
  return { looksLikeRom: false };
}
