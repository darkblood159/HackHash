// src/lib/bulkFamilyPrefill.ts
//
// What the bulk form may fill in from an EXISTING hack, once the name the
// person typed turns out to match one — the same autofill the single form's
// `applyFamilyPrefill` does (SubmitForm.tsx), as a pure function so the rules
// can be tested on their own, without React or the network.
//
// The rules are the single form's, deliberately:
//   - NEVER clobber: a field is only filled while it is still empty. Anything
//     the person typed, picked, or was already prefilled with wins.
//   - Only what the family actually has, and only the fields a hack's SHARED
//     details cover (platform, description, tags, game-database links,
//     franchise, author). Per-version things — version label, changelog,
//     release date, source URL, patch — are never copied from a sibling.
//     (The single form also fills a release date from the family; bulk has no
//     header-level release date — each version row has its own — so there is
//     nothing to fill.)
//   - Author: prefer a linked Author row; fall back to the family's plain-text
//     name for the many hacks whose author was typed before the Author list
//     existed (the form shows that name and lets the person drop it).
//
// The data comes from GET /api/entries/hack-family/[id], a public endpoint, so
// it is treated as untrusted JSON: every field is type-checked before use.

import type { MappingValues } from '@/components/MappingsSection';
import type { SelectedFranchise } from '@/components/FranchisePicker';
import type { SelectedAuthor } from '@/components/AuthorPicker';
import { MAPPING_FIELD_KEYS, isCorruptedMappingValue } from './mappingFields';

/** The fields that can be marked "auto-filled" in the form. */
export type FamilyPrefillField = 'platform' | 'description' | 'tags' | 'mappings' | 'franchise' | 'author';

/** What the form holds right now (the "is it still empty?" side). */
export interface FamilyPrefillCurrent {
  platform: string;
  description: string;
  tags: string[];
  mappings: MappingValues;
  /** A franchise is already picked. */
  hasFranchise: boolean;
  /** An Author is already picked (a carried-over plain name does NOT count — same as the single form). */
  hasAuthor: boolean;
}

/** The parts of the hack-family response this uses. All optional, none trusted. */
export interface FamilyPrefillData {
  platform?: unknown;
  description?: unknown;
  tags?: unknown;
  gameDatabaseLinks?: unknown;
  franchise?: unknown;
  author?: unknown;
  authorName?: unknown;
}

export interface FamilyPrefillPlan {
  platform?: string;
  description?: string;
  tags?: string[];
  /** The WHOLE new mappings object (current values plus the newly filled keys). */
  mappings?: MappingValues;
  franchise?: SelectedFranchise;
  author?: SelectedAuthor;
  /** Plain-text author carried over when the family has no linked Author. */
  legacyAuthor?: string;
  /** Exactly the fields this plan fills, for the "auto-filled" markers. */
  filled: FamilyPrefillField[];
}

const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

function asPicked(v: unknown): { id: string; name: string; status: 'PENDING' | 'APPROVED' } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!nonEmptyString(o.id) || !nonEmptyString(o.name)) return null;
  if (o.status !== 'PENDING' && o.status !== 'APPROVED') return null;
  return { id: o.id, name: o.name, status: o.status };
}

export function planFamilyPrefill(current: FamilyPrefillCurrent, data: FamilyPrefillData): FamilyPrefillPlan {
  const plan: FamilyPrefillPlan = { filled: [] };

  if (!current.platform && nonEmptyString(data.platform)) {
    plan.platform = data.platform;
    plan.filled.push('platform');
  }

  if (!current.description.trim() && nonEmptyString(data.description)) {
    plan.description = data.description;
    plan.filled.push('description');
  }

  if (current.tags.length === 0 && Array.isArray(data.tags)) {
    const tags = data.tags.filter((t): t is string => typeof t === 'string' && t.length > 0);
    if (tags.length > 0) {
      plan.tags = tags;
      plan.filled.push('tags');
    }
  }

  // Game-database links: per key, only into a slot that is still empty, and
  // never a value that is the literal text of a stringified object (the
  // signature of a since-fixed bug — see isCorruptedMappingValue): a known-bad
  // value on an old row must not be copied into a brand-new submission.
  if (data.gameDatabaseLinks && typeof data.gameDatabaseLinks === 'object') {
    const links = data.gameDatabaseLinks as Record<string, unknown>;
    const merged: MappingValues = { ...current.mappings };
    let any = false;
    for (const key of MAPPING_FIELD_KEYS) {
      const incoming = links[key];
      if (nonEmptyString(incoming) && !isCorruptedMappingValue(incoming) && !merged[key]) {
        merged[key] = incoming;
        any = true;
      }
    }
    if (any) {
      plan.mappings = merged;
      plan.filled.push('mappings');
    }
  }

  if (!current.hasFranchise) {
    const franchise = asPicked(data.franchise);
    if (franchise) {
      plan.franchise = franchise;
      plan.filled.push('franchise');
    }
  }

  if (!current.hasAuthor) {
    const author = asPicked(data.author);
    if (author) {
      plan.author = author;
      plan.filled.push('author');
    } else if (nonEmptyString(data.authorName)) {
      plan.legacyAuthor = data.authorName.trim();
      plan.filled.push('author');
    }
  }

  return plan;
}
