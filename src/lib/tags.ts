// src/lib/tags.ts
//
// Single source of truth for the descriptive tag list (Translation, Bug
// Fixes, Sprite/Character, etc). Previously duplicated separately in
// SubmitForm.tsx and TagFilters.tsx — same pattern that caused the
// mapping-field bugs, so centralizing it here before it causes a similar
// drift/mismatch bug.
//
// prisma/seed.ts also creates these rows, but that's no longer load-bearing
// for tags to work — ensureTagsExist() below creates any missing row on the
// fly from this list, so a database where seeding was skipped self-heals on
// first use instead of silently losing every tag.
//
// TWO-TIER SYSTEM (added August 2026): a `tier` of 'simple' or 'advanced'.
// SIMPLE is the small, friendly set shown by default (7 tags) — the goal
// is that an average submitter never has to think hard about it. ADVANCED
// is a much fuller breakdown (41 more tags) for people who want to be
// specific, including single-aspect tags for a hack that changes just one
// thing (e.g. "Music/BGM" on its own, with no other changes). The advanced
// set is loosely grounded in Europia79's IUPAG naming convention — see
// https://gist.github.com/Europia79/a51dd4632f8d4e4443d0048b70cb6e54 —
// specifically its "Folder Flags" section (hack-type classification and
// the ZFX effect-type sub-flags) and its Text-Language tag concept (see
// src/lib/languages.ts + translationLanguages on Submission). IUPAG's own
// naming-convention mechanics (region/author/date/revision tags, baserom
// suffixes, patch dependencies) are deliberately NOT modeled as tags here
// — this app already has dedicated fields for platform/author/releaseDate/
// version, and those IUPAG sections are about constructing a file NAME,
// not describing a hack. Every tag below gets a `description`, shown as a
// hover tooltip in the UI (see src/components/ui/Tooltip.tsx).

export type TagTier = 'simple' | 'advanced';

export const ALL_TAGS = [
  // ─── Simple (shown by default, no group — always renders as one flat row) ───
  { slug: 'improvement', name: 'Improvement', tier: 'simple', description: 'General quality-of-life or polish changes, without adding new levels.', group: undefined },
  { slug: 'translation', name: 'Translation', tier: 'simple', description: "Translates the game's text into a different language.", group: undefined },
  { slug: 'new-levels', name: 'New Levels', tier: 'simple', description: 'Adds entirely new levels or areas to the game.', group: undefined },
  { slug: 'gameplay', name: 'Gameplay Changes', tier: 'simple', description: 'Changes how the game plays — mechanics, balance, controls, or level design.', group: undefined },
  { slug: 'graphical', name: 'Graphics/Audio', tier: 'simple', description: "Changes the game's graphics and/or audio.", group: undefined },
  { slug: 'bug-fix', name: 'Bug Fixes', tier: 'simple', description: 'Fixes bugs or glitches in the original game.', group: undefined },
  { slug: 'total-conversion', name: 'Total Conversions', tier: 'simple', description: 'A complete overhaul — new story, levels, and mechanics built on the original engine.', group: undefined },

  // ─── Advanced: Content & Scope ──────────────────────────────────────────
  { slug: 'expansion', name: 'Expansion', tier: 'advanced', description: 'Adds new areas or story content beyond the base game, without being a full overhaul.', group: 'Content & Scope' },
  { slug: 'different-genre', name: 'Different Genre', tier: 'advanced', description: 'Changes the game into a different genre than the original.', group: 'Content & Scope' },
  { slug: 'region-conversion', name: 'Region Conversion', tier: 'advanced', description: 'Converts the game between regions — PAL/NTSC, speed, or timing fixes.', group: 'Content & Scope' },

  // ─── Advanced: Special Formats ───────────────────────────────────────────
  { slug: 'difficulty-hack', name: 'Difficulty Hack', tier: 'advanced', description: "Changes the game's overall difficulty, easier or harder.", group: 'Special Formats' },
  { slug: 'randomizer', name: 'Randomizer', tier: 'advanced', description: 'Shuffles items, enemies, or other elements for a different playthrough each time.', group: 'Special Formats' },
  { slug: 'puzzle-hack', name: 'Puzzle Hack', tier: 'advanced', description: 'Heavily focused on puzzle-solving.', group: 'Special Formats' },
  { slug: 'holiday-hack', name: 'Holiday Hack', tier: 'advanced', description: 'Themed around a holiday.', group: 'Special Formats' },
  { slug: 'contest-entry', name: 'Contest Entry', tier: 'advanced', description: 'Submitted as part of a ROM hacking contest.', group: 'Special Formats' },
  { slug: 'troll-hack', name: 'Troll Hack', tier: 'advanced', description: 'Deliberately subverts player expectations with tricks and traps.', group: 'Special Formats' },
  { slug: 'joke-meme-hack', name: 'Joke/Meme Hack', tier: 'advanced', description: 'Built for humor, not intended as a genuine playthrough.', group: 'Special Formats' },
  { slug: 'kaizo-extreme-difficulty', name: 'Kaizo/Extreme Difficulty', tier: 'advanced', description: 'Extremely difficult, precision-based hack built for expert players.', group: 'Special Formats' },

  // ─── Advanced: Graphics (single-aspect) ─────────────────────────────────
  { slug: 'sprite-character', name: 'Sprite/Character', tier: 'advanced', description: 'Changes character or enemy sprites.', group: 'Graphics' },
  { slug: 'environment-texture', name: 'Environment/Texture', tier: 'advanced', description: 'Changes environment textures, tiles, or backgrounds.', group: 'Graphics' },
  { slug: 'palette-color-swap', name: 'Palette/Color Swap', tier: 'advanced', description: 'Changes colors or palettes without altering the art itself.', group: 'Graphics' },
  { slug: 'title-screen', name: 'Title Screen', tier: 'advanced', description: 'Changes the title screen or intro.', group: 'Graphics' },
  { slug: 'ui-hud', name: 'UI/HUD', tier: 'advanced', description: 'Changes menus, the heads-up display, or other interface elements.', group: 'Graphics' },
  { slug: 'cutscene-artwork', name: 'Cutscene/Artwork', tier: 'advanced', description: 'Changes cutscenes or other artwork.', group: 'Graphics' },

  // ─── Advanced: Audio (single-aspect) ─────────────────────────────────────
  { slug: 'music-bgm', name: 'Music/BGM', tier: 'advanced', description: 'Changes background music.', group: 'Audio' },
  { slug: 'sound-effects', name: 'Sound Effects', tier: 'advanced', description: 'Changes sound effects.', group: 'Audio' },
  { slug: 'voice-dialogue', name: 'Voice/Dialogue', tier: 'advanced', description: 'Changes voice acting or spoken dialogue audio.', group: 'Audio' },

  // ─── Advanced: Gameplay/Mechanics (single-aspect) ────────────────────────
  { slug: 'physics-movement', name: 'Physics/Movement', tier: 'advanced', description: 'Changes movement, jumping, or physics.', group: 'Gameplay/Mechanics' },
  { slug: 'combat-damage-balance', name: 'Combat/Damage Balance', tier: 'advanced', description: 'Changes combat, damage values, or difficulty balance.', group: 'Gameplay/Mechanics' },
  { slug: 'ai-enemy-behavior', name: 'AI/Enemy Behavior', tier: 'advanced', description: 'Changes enemy behavior or AI.', group: 'Gameplay/Mechanics' },
  { slug: 'level-layout-edit', name: 'Level Layout Edit', tier: 'advanced', description: 'Edits the layout of existing levels, without adding entirely new ones.', group: 'Gameplay/Mechanics' },
  { slug: 'items-economy', name: 'Items/Economy', tier: 'advanced', description: "Changes items, shops, or the game's economy.", group: 'Gameplay/Mechanics' },
  { slug: 'controls-input', name: 'Controls/Input', tier: 'advanced', description: 'Changes control schemes or input handling.', group: 'Gameplay/Mechanics' },
  { slug: 'progression-difficulty-curve', name: 'Progression/Difficulty Curve', tier: 'advanced', description: 'Changes how difficulty or progression ramps up over the course of the game.', group: 'Gameplay/Mechanics' },

  // ─── Advanced: Text ────────────────────────────────────────────────────
  { slug: 'dialogue-script-edit', name: 'Dialogue/Script Edit', tier: 'advanced', description: 'Edits in-game text or dialogue without translating it into another language.', group: 'Text' },
  { slug: 'font-replacement', name: 'Font Replacement', tier: 'advanced', description: 'Replaces the in-game font.', group: 'Text' },

  // ─── Advanced: Translation Detail ───────────────────────────────────────
  { slug: 'undub', name: 'Undub', tier: 'advanced', description: 'Keeps the original audio/voice but translates the text.', group: 'Translation Detail' },
  { slug: 'uncensor', name: 'Uncensor', tier: 'advanced', description: 'Restores content that was removed or altered in an official localization.', group: 'Translation Detail' },
  { slug: 'literal-translation', name: 'Literal Translation', tier: 'advanced', description: 'A close, word-for-word translation.', group: 'Translation Detail' },
  { slug: 'localization', name: 'Localization', tier: 'advanced', description: 'A culturally-adapted translation, rather than a literal one.', group: 'Translation Detail' },

  // ─── Advanced: Technical ─────────────────────────────────────────────────
  { slug: 'cheat-trainer', name: 'Cheat/Trainer', tier: 'advanced', description: 'Adds cheats or a cheat menu.', group: 'Technical' },
  { slug: 'other-tweak', name: 'Other Tweak', tier: 'advanced', description: "A small change that doesn't fit any other category.", group: 'Technical' },

  // ─── Advanced: Preservation & Status ─────────────────────────────────────
  { slug: 'restoration', name: 'Restoration', tier: 'advanced', description: 'Restores content that was cut or changed from the original release.', group: 'Preservation & Status' },
  { slug: 'beta-proto-restoration', name: 'Beta/Proto Restoration', tier: 'advanced', description: 'Restores content recovered from a prototype or beta build.', group: 'Preservation & Status' },
  { slug: 'homebrew', name: 'Homebrew', tier: 'advanced', description: "An original, non-commercial game built for the base system's hardware — not a modification of an existing game.", group: 'Preservation & Status' },
  { slug: 'unfinished', name: 'Unfinished', tier: 'advanced', description: 'Incomplete — missing content or polish, but playable.', group: 'Preservation & Status' },

  // ─── Advanced: Content Advisory ──────────────────────────────────────────
  { slug: 'flashing-lights-warning', name: 'Flashing Lights Warning', tier: 'advanced', description: 'Contains flashing lights or effects that may affect photosensitive players.', group: 'Content Advisory' },
  { slug: 'mature-nsfw-content', name: 'Mature/NSFW Content', tier: 'advanced', description: 'Contains mature or NSFW content.', group: 'Content Advisory' },
] as const;

export type TagSlug = (typeof ALL_TAGS)[number]['slug'];
export type TagDefinition = (typeof ALL_TAGS)[number];

export const ALL_TAG_SLUGS = ALL_TAGS.map((t) => t.slug);

export const SIMPLE_TAGS = ALL_TAGS.filter((t) => t.tier === 'simple');
export const ADVANCED_TAGS = ALL_TAGS.filter((t) => t.tier === 'advanced');

/**
 * Advanced tags bucketed by group, in the same order groups first appear
 * in ALL_TAGS above (insertion order is preserved for string Map keys, so
 * this doesn't need a separately-maintained ordering list). UI components
 * (TagsEditor, TagFilters) both read this rather than grouping themselves,
 * so the two pickers can't drift into showing groups in a different order.
 */
export const ADVANCED_TAG_GROUPS: { group: string; tags: TagDefinition[] }[] = (() => {
  const byGroup = new Map<string, TagDefinition[]>();
  for (const tag of ADVANCED_TAGS) {
    const key = tag.group ?? 'Other';
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key)!.push(tag);
  }
  return Array.from(byGroup.entries()).map(([group, tags]) => ({ group, tags }));
})();

/**
 * Tag slugs that mean "this is a translation of some kind" — when any of
 * these is selected, the UI shows the language picker (src/components/
 * LanguagePicker.tsx) so the submitter can say which language(s). Includes
 * the simple "translation" tag plus the advanced Translation Detail
 * sub-tags, since picking e.g. "Undub" or "Localization" without also
 * picking the broader "Translation" tag is a perfectly reasonable thing to
 * do in advanced mode.
 */
export const TRANSLATION_TRIGGER_SLUGS: readonly string[] = [
  'translation', 'undub', 'uncensor', 'literal-translation', 'localization',
];

/**
 * Resolve a list of tag slugs to their DB rows, CREATING any that don't
 * exist yet instead of silently skipping them, and RECONCILING metadata
 * (name/tier/description/group) on every resolve rather than only at
 * creation time.
 *
 * Why this exists: both the submission-create route and the admin tag-edit
 * route used to do a plain findUnique/findMany lookup and just skip any
 * slug with no matching row — no error, nothing logged. If prisma/seed.ts
 * is ever not run on a given database (a real, easy-to-forget manual step —
 * see the Docker guide), EVERY tag silently fails to attach, with zero
 * indication anywhere of why. Since src/lib/tags.ts is already the single
 * source of truth for valid slugs+names, resolving through here means a
 * fresh/unseeded database self-heals on first real use instead of quietly
 * losing every tag forever.
 *
 * The metadata sync (added alongside the simple/advanced overhaul) means
 * that if ALL_TAGS itself is ever edited later — a description tweak, a
 * tag moving tiers or groups — every existing DB row self-heals into
 * agreement the next time anyone submits or edits with that tag, rather
 * than drifting permanently out of sync with what the UI shows.
 *
 * Only creates/updates rows for slugs that are actually in ALL_TAGS — an
 * unknown slug is silently ignored (that part is intentional; it's not a
 * name a user can type themselves, so an unknown value here means a bug,
 * not a legitimate new tag).
 */
export async function ensureTagsExist(
  tx: { tag: { upsert: (args: any) => Promise<any> } },
  slugs: string[]
): Promise<{ id: string; slug: string }[]> {
  const valid = slugs.filter((s): s is TagSlug => (ALL_TAG_SLUGS as readonly string[]).includes(s));
  if (valid.length === 0) return [];

  const byDef = new Map<TagSlug, TagDefinition>(ALL_TAGS.map((t) => [t.slug, t]));
  const rows = await Promise.all(
    valid.map((slug) => {
      const def = byDef.get(slug)!;
      const data = { name: def.name, tier: def.tier.toUpperCase(), description: def.description, tagGroup: def.group ?? null };
      return tx.tag.upsert({
        where: { slug },
        update: data,
        create: { slug, ...data },
      });
    })
  );
  return rows;
}
