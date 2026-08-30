-- Tags overhaul: simple vs. advanced modes, plus a per-version translation
-- language field. Purely additive — no existing row's tag assignments
-- (SubmissionTag rows) are touched, and every one of the 11 pre-existing
-- Tag rows keeps its original slug (only tier/tagGroup/description are
-- added, and 4 display names are clarified to match the new simple-mode
-- wording — see src/lib/tags.ts for the full reasoning).

-- CreateEnum
CREATE TYPE "TagTier" AS ENUM ('SIMPLE', 'ADVANCED');

-- AlterTable: Tag
ALTER TABLE "Tag" ADD COLUMN "tier" "TagTier" NOT NULL DEFAULT 'ADVANCED';
ALTER TABLE "Tag" ADD COLUMN "description" TEXT;
ALTER TABLE "Tag" ADD COLUMN "tagGroup" TEXT;

-- AlterTable: Submission — which language(s) a translation was done into,
-- e.g. ['es','fr']. Empty array (not null) is the honest "not specified"
-- state for every pre-existing row — nothing fabricated.
ALTER TABLE "Submission" ADD COLUMN "translationLanguages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- AlterTable: ChangeRequest — mirrors proposedTags exactly (null = no
-- change proposed, [] = explicitly propose clearing).
ALTER TABLE "ChangeRequest" ADD COLUMN "proposedTranslationLanguages" JSONB;

-- Backfill correct tier/description/name for the 11 tags that already
-- exist in every live database. These UPDATEs are idempotent (safe to
-- re-run) and only touch rows by their known, stable slug — nothing here
-- depends on prisma/seed.ts or ensureTagsExist() having run first, so the
-- picker is immediately correct the moment this migration applies, not
-- just the next time someone happens to submit or edit a tag.

-- Simple tier (7 total — 6 pre-existing relabeled/kept, 1 brand new further
-- down). Display names updated to match the plainer simple-mode wording;
-- slugs are untouched so no existing SubmissionTag row is affected.
UPDATE "Tag" SET "tier" = 'SIMPLE', "description" = 'General quality-of-life or polish changes, without adding new levels.' WHERE "slug" = 'improvement';
UPDATE "Tag" SET "tier" = 'SIMPLE', "description" = 'Translates the game''s text into a different language.' WHERE "slug" = 'translation';
UPDATE "Tag" SET "tier" = 'SIMPLE', "name" = 'Gameplay Changes', "description" = 'Changes how the game plays — mechanics, balance, controls, or level design.' WHERE "slug" = 'gameplay';
UPDATE "Tag" SET "tier" = 'SIMPLE', "name" = 'Graphics/Audio', "description" = 'Changes the game''s graphics and/or audio.' WHERE "slug" = 'graphical';
UPDATE "Tag" SET "tier" = 'SIMPLE', "name" = 'Bug Fixes', "description" = 'Fixes bugs or glitches in the original game.' WHERE "slug" = 'bug-fix';
UPDATE "Tag" SET "tier" = 'SIMPLE', "name" = 'Total Conversions', "description" = 'A complete overhaul — new story, levels, and mechanics built on the original engine.' WHERE "slug" = 'total-conversion';

-- Advanced tier — pre-existing tags that move here unchanged in name/slug,
-- just gaining a tier/group/description they never had before.
UPDATE "Tag" SET "tier" = 'ADVANCED', "tagGroup" = 'Special Formats', "description" = 'Changes the game''s overall difficulty, easier or harder.' WHERE "slug" = 'difficulty-hack';
UPDATE "Tag" SET "tier" = 'ADVANCED', "tagGroup" = 'Special Formats', "description" = 'Shuffles items, enemies, or other elements for a different playthrough each time.' WHERE "slug" = 'randomizer';
UPDATE "Tag" SET "tier" = 'ADVANCED', "tagGroup" = 'Preservation & Status', "description" = 'Restores content that was cut or changed from the original release.' WHERE "slug" = 'restoration';
UPDATE "Tag" SET "tier" = 'ADVANCED', "tagGroup" = 'Preservation & Status', "description" = 'An original, non-commercial game built for the base system''s hardware — not a modification of an existing game.' WHERE "slug" = 'homebrew';
UPDATE "Tag" SET "tier" = 'ADVANCED', "tagGroup" = 'Preservation & Status', "description" = 'Incomplete — missing content or polish, but playable.' WHERE "slug" = 'unfinished';

-- Everything else (the 1 new simple tag + 36 new advanced tags) is created
-- lazily by ensureTagsExist() the first time it's actually used, same
-- self-healing pattern this project has used for tags since the original
-- silent-skip bug fix — no INSERT needed here. The full canonical list
-- lives in src/lib/tags.ts (ALL_TAGS).
