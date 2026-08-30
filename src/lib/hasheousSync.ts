// src/lib/hasheousSync.ts
//
// Single-submission Hasheous pull: look up one submission's hash against
// Hasheous, extract any mapping data found, resolve an IGDB slug if
// possible, and upsert it into GameMapping.
//
// This exact sequence used to be duplicated independently in two places —
// the manual pull job (api/admin/hasheous/pull/route.ts) and the background
// scheduler (syncScheduler.ts auto-pull) — which is the same kind of
// duplication that caused the mapping-field bugs fixed earlier (see
// mappingFields.ts). Centralized here so there's one place to fix if the
// logic ever needs to change, and so the new "pull immediately on approval"
// trigger (approval.ts) doesn't become a third copy.

import { prisma } from './prisma';
import {
  lookupByHashes, extractMappings, extractCanonicalFields, pullIGDBMetadata,
  hasClientApiKey, getHasheousBaseUrl, type HasheousEnv,
} from './hasheous';

// The only fields Hasheous's FixMatch endpoint actually accepts (see
// pushMappingToHasheous in hasheous.ts) — steamId/wikipediaUrl/igdbSlug/
// canonicalName/canonicalDescription/canonicalReleaseDate/hasheousLinks are
// never sent, so there's nothing to verify for them. gogId/epicGamesId
// added Aug 14 — both are pushable MetadataSources this project has a
// GameMapping column for but had never actually included in a push before.
const PUSHABLE_FIELDS = [
  'igdbId', 'theGamesDBId', 'giantBombId', 'launchboxId',
  'screenScraperId', 'steamGridDBId', 'retroAchievementsId',
  'gogId', 'epicGamesId',
] as const;

// The full set of scalar mapping-ID fields a pull can populate — every
// PUSHABLE_FIELDS entry plus steamId/wikipediaUrl (extracted on pull but
// never pushed) and igdbSlug (derived, not independently user-editable).
// Used by the overwrite:true branch below so a forced re-check can be fully
// authoritative — including clearing a field Hasheous no longer maps, not
// just filling in new ones.
const ALL_MAPPING_ID_FIELDS = [
  'igdbId', 'igdbSlug', 'theGamesDBId', 'giantBombId', 'launchboxId',
  'screenScraperId', 'steamGridDBId', 'retroAchievementsId', 'steamId',
  'gogId', 'epicGamesId', 'wikipediaUrl',
] as const;

// How long to wait after a push before treating "Hasheous still doesn't
// show it" as a real problem worth flagging, rather than just normal
// processing delay. Hasheous itself estimates ~24h; doubled for margin
// since that's their own estimate, not a guarantee.
const PUSH_VERIFICATION_GRACE_MS = 48 * 60 * 60 * 1000;

/**
 * Call this right after a successful push (HTTP 200 from FixMatch) to start
 * tracking whether it actually takes effect. Snapshots exactly which values
 * were sent so a later pull can compare Hasheous's current data against
 * them — see the verification block inside pullMappingForSubmission below.
 * A no-op if nothing was actually in the push payload.
 */
export async function recordPushResult(
  gameMappingId: string,
  mapping: Partial<Record<(typeof PUSHABLE_FIELDS)[number], string | null | undefined>>
) {
  const pushedFields: Record<string, string> = {};
  for (const key of PUSHABLE_FIELDS) {
    if (mapping[key]) pushedFields[key] = mapping[key]!;
  }
  if (Object.keys(pushedFields).length === 0) return;

  await prisma.gameMapping.update({
    where: { id: gameMappingId },
    data: {
      hasheousPushedAt: new Date(),
      hasheousPushedFields: pushedFields,
      hasheousPushStatus: 'pending',
      hasheousPushVerifiedAt: null, // a new push supersedes any prior confirmation/flag
    },
  });
}

/**
 * Wraps recordPushResult with the Aug-14 accepted/rejected filtering — only
 * fields Hasheous's FixMatch response actually said "OK" to get snapshotted
 * for verification. A rejected field (bad/stale id) would never confirm
 * anyway, since Hasheous never recorded a vote for it — tracking it as
 * "pending" would just sit there forever looking like a stuck sync instead
 * of the outright rejection it actually was. If the response couldn't be
 * parsed (pushResult.accepted is undefined), falls back to recording
 * everything sent, same as before this fix, since "unknown" shouldn't be
 * treated as "definitely rejected" either.
 *
 * All three push call sites (manual push route, approval.ts's
 * triggerHasheousPushForSubmission, syncScheduler.ts's runAutoPush) share
 * this instead of each re-implementing the same filter — see the "assuming
 * the one call site you found is the only one" lesson elsewhere in this
 * project's history for why that's worth avoiding here specifically.
 */
export async function recordAcceptedPushResult(
  gameMappingId: string,
  sentMappings: Partial<Record<(typeof PUSHABLE_FIELDS)[number], string | null | undefined>>,
  pushResult: { accepted?: string[] }
) {
  const toRecord = pushResult.accepted
    ? (Object.fromEntries(
        Object.entries(sentMappings).filter(([key]) => pushResult.accepted!.includes(key))
      ) as typeof sentMappings)
    : sentMappings;
  await recordPushResult(gameMappingId, toRecord);
}

export interface PullOneResult {
  found: boolean;
  updated: boolean;
  appliedKeys: string[];
  error?: string;
}

export async function pullMappingForSubmission(
  sub: { id: string; sha1: string; md5: string; crc32: string; hackName: string; gameMappingId?: string | null },
  env: HasheousEnv,
  overwrite = false
): Promise<PullOneResult> {
  try {
    const result = await lookupByHashes({ sha1: sub.sha1, md5: sub.md5, crc32: sub.crc32 }, env);
    if (!result || typeof result !== 'object') {
      return { found: false, updated: false, appliedKeys: [] };
    }

    const existingMapping: any = sub.gameMappingId
      ? await prisma.gameMapping.findUnique({ where: { id: sub.gameMappingId } })
      : null;

    const extracted = extractMappings(result);
    const canonical = extractCanonicalFields(result);

    const data: Record<string, any> = {
      hasheousId: result.id != null ? String(result.id) : (existingMapping?.hasheousId ?? null),
      hasheousEnv: env,
      hasheousSyncedAt: new Date(),
      hasheousSyncStatus: 'ok',
      hasheousSyncError: null,
    };
    if (canonical.name && (overwrite || !existingMapping?.canonicalName)) {
      data.canonicalName = canonical.name;
    }
    if (canonical.description && (overwrite || !existingMapping?.canonicalDescription)) {
      data.canonicalDescription = canonical.description;
    }

    // Push verification — if there's a push we haven't confirmed one way or
    // the other yet, check whether Hasheous's CURRENT data (this pull, not
    // whatever was cached before) now matches what we sent. Confirming early
    // (well before the 48h grace period) is fine and good; only the "still
    // doesn't match" case waits out the grace period before being flagged,
    // since that's expected/normal for a while.
    //
    // AUG-24 FIX: this used to be gated on hasheousPushStatus === 'pending'
    // only — meaning once a push aged past the 48h grace period and got
    // flagged 'not_reflected', this entire block stopped running for it on
    // EVERY FUTURE PULL, forever (the condition was simply false from then
    // on, scheduler or manual Force re-check alike). If Hasheous's data
    // genuinely came to match later — the vote finally got its 3rd
    // independent agreement, or an admin corrected it directly on
    // Hasheous's own site — there was no way for this to ever notice and
    // flip to 'confirmed'; the badge would sit on "not confirmed 48h+ after
    // the vote" permanently, even once the underlying field was correct,
    // until someone pushed again from here (which resets to 'pending' and
    // re-arms this check). Now a 'not_reflected' row is also re-checked on
    // every pull — if it matches now, it self-heals to 'confirmed' exactly
    // like a 'pending' one would; if it still doesn't match, it silently
    // stays 'not_reflected' (no need to re-run the grace-period timer, it's
    // already past it — see the `else if` below).
    if (
      (existingMapping?.hasheousPushStatus === 'pending' || existingMapping?.hasheousPushStatus === 'not_reflected') &&
      existingMapping?.hasheousPushedFields
    ) {
      const pushedFields = existingMapping.hasheousPushedFields as Record<string, string>;
      const allMatch = Object.entries(pushedFields).every(
        ([key, pushedValue]) => extracted[key as keyof typeof extracted] === pushedValue
      );

      if (allMatch) {
        data.hasheousPushStatus = 'confirmed';
        data.hasheousPushVerifiedAt = new Date();
      } else if (existingMapping.hasheousPushStatus === 'pending') {
        const pushAgeMs = Date.now() - new Date(existingMapping.hasheousPushedAt).getTime();
        if (pushAgeMs >= PUSH_VERIFICATION_GRACE_MS) {
          data.hasheousPushStatus = 'not_reflected';
        }
        // else: still within the grace period — leave status as 'pending', try again next pull
      }
      // else: already 'not_reflected' and still doesn't match — nothing to
      // update here, stays 'not_reflected' until it either matches (above)
      // or a fresh push resets the snapshot and re-arms the 48h timer.
    }

    // THE AUG-14 (LATEST) FIX: an `overwrite:true` pull is now fully
    // authoritative for the standard mapping-ID fields, including CLEARING
    // one Hasheous no longer maps — found live: a normal pull only ever
    // added/kept values, it never removed one, so a mapping later
    // un-matched on Hasheous's end (a vote correction, an admin fixing a
    // bad Automatic match, etc.) would sit stale here forever with no way
    // to notice, even via the "Force re-check" button, since that already
    // sends overwrite:true and STILL hit this exact gap. Deliberately
    // scoped to overwrite:true only (an explicit admin action — Force
    // re-check, or a bulk pull run with overwrite:true) — the routine 6h
    // scheduler (overwrite:false) keeps the original conservative
    // fill-empty-fields-only behavior below, so a field a human manually
    // curated can't get silently wiped just because Hasheous hasn't
    // matched that particular source (which is common and not itself a
    // sign anything is wrong).
    //
    // SECOND FIX, found live the same day: the above alone had a real gap —
    // pushing a correction and then immediately hitting Force re-check
    // would clear the value right back out. Hasheous's own FixMatch is a
    // VOTE, applied later by a background tally on THEIR side (see section
    // 2n) — a pull run seconds/minutes after a push will correctly NOT see
    // it yet, because it genuinely hasn't been applied there yet. That's
    // "not applied YET", not "removed", and the old logic couldn't tell the
    // two apart. Fixed by protecting any field that's part of the CURRENT
    // pending push snapshot (hasheousPushedFields, while hasheousPushStatus
    // is still 'pending') from being cleared here — it stays exactly as it
    // is until the push-verification system above settles it one way or
    // the other (confirmed — obviously don't clear it; or not_reflected,
    // once its own 48h grace period genuinely elapses — at which point it's
    // no longer 'pending' and this protection naturally stops applying, so
    // a LATER pull can still clear it if it's genuinely gone). This reuses
    // the existing verification machinery rather than adding a separate
    // cooldown — "pending" already means exactly "pushed, not yet
    // confirmed one way or the other."
    const pushProtectedFields = new Set<string>();
    if (existingMapping?.hasheousPushStatus === 'pending' && existingMapping?.hasheousPushedFields) {
      for (const key of Object.keys(existingMapping.hasheousPushedFields as Record<string, string>)) {
        pushProtectedFields.add(key);
      }
    }

    const appliedKeys: string[] = [];
    if (overwrite) {
      // AUG-24 DIAGNOSTIC LOGGING, scoped to overwrite:true (Force re-check,
      // or an explicit bulk overwrite pull) only — not the routine 6h
      // scheduler, so this doesn't spam its log on every unremarkable run.
      // Added in response to a "Force re-check still shows old information,
      // no matter what I try" report. Re-read extractMappings() and this
      // whole overwrite branch fresh against that report and found nothing
      // wrong in either (no matchMethod filtering that would skip a
      // Manual/ManualByAdmin-sourced value, no stale caching in this code) —
      // so the two most likely remaining causes are (a) this pull hit a
      // different Hasheous environment than wherever the data was actually
      // corrected (beta vs. production are separate databases on Hasheous's
      // side; env is resolved purely from HASHEOUS_ENV / the request body,
      // never from anything stored per-submission — see getHasheousBaseUrl),
      // or (b) this hash resolves to a different Hasheous DataObject than
      // whatever page was actually edited. Logging the resolved env/baseUrl/
      // hasheousId plus a full extracted-vs-stored diff here so both are
      // checkable directly from the server console on the next attempt,
      // instead of guessing further without a concrete case to look at.
      console.log(`[hasheous] force re-check "${sub.hackName}" (${sub.id}): queried ${getHasheousBaseUrl(env)} (env=${env}), hasheousId=${result.id ?? '(no id in response)'}`);

      for (const key of ALL_MAPPING_ID_FIELDS) {
        const newValue = (extracted as Record<string, string | undefined>)[key] ?? null;
        const oldValue = existingMapping?.[key] ?? null;
        if (newValue === null && oldValue !== null && pushProtectedFields.has(key)) {
          console.log(`[hasheous]   ${key}: stored="${oldValue}", hasheous shows nothing right now — NOT clearing, this field's push is still pending confirmation`);
          continue; // freshly pushed, not yet confirmed — see comment above, don't clear it
        }
        if (newValue !== oldValue) {
          console.log(`[hasheous]   ${key}: stored="${oldValue ?? '(empty)'}" -> hasheous now says "${newValue ?? '(empty)'}"`);
          data[key] = newValue;
          appliedKeys.push(key);
        }
      }
      if (appliedKeys.length === 0) {
        console.log('[hasheous]   no differences — every mapping-ID field Hasheous returned already matches what\'s currently stored');
      }
      // Same authoritative treatment for the cached links — replaced, not
      // merged, so a source that just got cleared above doesn't leave a
      // stale link pointing at a mapping that no longer exists.
      data.hasheousLinks = extracted.links && Object.keys(extracted.links).length > 0
        ? extracted.links
        : null;
    } else {
      for (const [key, value] of Object.entries(extracted)) {
        if (key === 'links') continue; // not a scalar GameMapping column, handled below
        if (!value) continue;
        if (existingMapping?.[key]) continue; // never touch an already-set field on a routine pull
        data[key] = value;
        appliedKeys.push(key);
      }
      // Merged rather than replaced — a routine pull that didn't return
      // metadata for some source shouldn't drop a previously-known link for
      // it; only an explicit overwrite pull (above) treats absence as
      // meaningful.
      if (extracted.links && Object.keys(extracted.links).length > 0) {
        data.hasheousLinks = { ...(existingMapping?.hasheousLinks ?? {}), ...extracted.links };
      }
    }

    // Release date — the one canonical field that genuinely still needs the
    // separate MetadataProxy call. Confirmed against Hasheous's own
    // DataObjectDefinitions: Game objects don't carry a release-date
    // attribute in their model at all, unlike name/description/links above,
    // which now all come straight off the primary lookup with zero extra
    // auth. Gracefully skipped (one log line inside pullIGDBMetadata, not a
    // repeated error) when HASHEOUS_CLIENT_API_KEY isn't configured yet —
    // see .env.example. igdbSlug no longer depends on this call at all
    // (see extractMappings), so slug/link resolution works regardless of
    // whether a client key is set up.
    //
    // Resolved via a local variable rather than `data.igdbId ?? existingMapping?.igdbId`
    // (an earlier version) — falling back to existingMapping unconditionally
    // would fetch a release date for an igdbId this same pull might have
    // just genuinely cleared as no-longer-valid, immediately above. Checking
    // `'igdbId' in data` specifically (rather than `extracted.igdbId`)
    // correctly reflects a PROTECTED value too — if the loop above left
    // igdbId untouched because it's a pending, not-yet-confirmed push (see
    // the protection comment above), data.igdbId was never set, so this
    // correctly falls through to the retained existingMapping value instead
    // of treating it as cleared.
    const resolvedIgdbId = overwrite
      ? (('igdbId' in data ? data.igdbId : existingMapping?.igdbId) ?? null)
      : (existingMapping?.igdbId || extracted.igdbId || null);

    if (resolvedIgdbId && hasClientApiKey() && (overwrite || !existingMapping?.canonicalReleaseDate)) {
      try {
        const meta = await pullIGDBMetadata(resolvedIgdbId, env);
        if (meta?.releaseDate) {
          data.canonicalReleaseDate = meta.releaseDate;
        }
      } catch (e: any) {
        console.error(`[hasheous] release-date fetch threw for ${sub.hackName} (igdbId=${resolvedIgdbId}):`, e?.message ?? e);
      }
    } else if (overwrite && !resolvedIgdbId && existingMapping?.canonicalReleaseDate) {
      // The IGDB mapping this date was derived from was just cleared above
      // — an orphaned date attached to nothing is worse than no date, so
      // clear it too rather than leave it looking current.
      data.canonicalReleaseDate = null;
    }

    if (existingMapping) {
      await prisma.gameMapping.update({ where: { id: existingMapping.id }, data });
    } else {
      const mapping = await prisma.gameMapping.create({ data });
      await prisma.submission.update({ where: { id: sub.id }, data: { gameMappingId: mapping.id } });
    }

    return { found: true, updated: appliedKeys.length > 0, appliedKeys };
  } catch (err: any) {
    return { found: false, updated: false, appliedKeys: [], error: err?.message ?? 'Unknown error' };
  }
}
