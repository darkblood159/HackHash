// src/lib/syncScheduler.ts
//
// Background scheduler for automatic Hasheous sync. Pinned to globalThis so
// it survives Next.js dev-mode hot reloads (same pattern as jobStore.ts).
// Started once per server boot by instrumentation.ts (which needs
// `experimental.instrumentationHook` in next.config.js — it has it).
//
// Two operations run on separate intervals (all numbers live in
// syncConfig.ts — change them there, the admin page displays them too):
//
//   PULL (every 6 hours, plus once ~15s after boot). Two tiers, one job:
//
//     1. NEEDS SYNC — approved entries with no successful Hasheous pull yet
//        (no mapping, a hand-entered mapping that was never synced, an
//        errored/half-finished one, a mapping from a different Hasheous
//        environment than the current one, an IGDB id without its slug),
//        plus anything with a push awaiting verification. This is the
//        "has Hasheous learned about our DAT yet?" poll: a hash only starts
//        matching after Hasheous imports a DAT containing it, and Hasheous
//        can't notify us, so we ask. Each entry is asked at most once per
//        NOT_FOUND_RECHECK_MS (24h), oldest-asked first, so every unresolved
//        entry gets its turn instead of the same newest 200 being re-asked
//        forever while everything behind them starved.
//
//     2. REFRESH — entries that already synced are re-checked every
//        SYNCED_REFRESH_MS (7 days), oldest first, fill-only (never
//        overwrites or clears). Previously a row marked 'ok' was NEVER looked
//        at again, so IDs Hasheous added afterwards (an IGDB/RetroAchievements
//        match it hadn't made yet when we first pulled) were never noticed.
//
//   PUSH (every 30 minutes): Scans for approved entries whose GameMapping
//   has mapping IDs but hasn't been pushed to Hasheous yet. This handles
//   the "new data entered via UI after the last manual push" case.
//
// Both are deliberately conservative — they only touch a small batch per
// cycle to avoid hammering Hasheous. The manual pull/push remain available
// for big one-off operations. It does nothing in test/build environments.

import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { pushMappingToHasheous, getHasheousBaseUrl, type HasheousEnv } from './hasheous';
import { pullMappingForSubmission, recordAcceptedPushResult, NEEDS_FIRST_SYNC_CLAUSES } from './hasheousSync';
import {
  PULL_INTERVAL_MS, PUSH_INTERVAL_MS, PULL_BATCH, REFRESH_BATCH, PUSH_BATCH,
  PULL_DELAY_MS, PUSH_DELAY_MS, NOT_FOUND_RECHECK_MS, SYNCED_REFRESH_MS,
  MAX_CONSECUTIVE_LOOKUP_ERRORS,
} from './syncConfig';

declare global {
  // eslint-disable-next-line no-var
  var __hasheousSyncStarted: boolean | undefined;
  // eslint-disable-next-line no-var
  var __hasheousPullRunning: boolean | undefined;
}

function getEnv(): HasheousEnv {
  return (process.env.HASHEOUS_ENV as HasheousEnv | undefined) ?? 'beta';
}

const PULL_SELECT = {
  id: true, sha1: true, md5: true, crc32: true, hackName: true, gameMappingId: true,
} as const;

// Never-checked first, then longest-since-checked, newest approvals breaking
// ties — so a brand-new approval is still picked up fast, but a long-ignored
// entry can no longer be starved by newer ones that keep coming back "not
// found".
const PULL_ORDER: Prisma.SubmissionOrderByWithRelationInput[] = [
  { hasheousCheckedAt: { sort: 'asc', nulls: 'first' } },
  { createdAt: 'desc' },
];

type PullCandidate = Prisma.SubmissionGetPayload<{ select: typeof PULL_SELECT }>;

function dueBefore(cutoff: Date): Prisma.SubmissionWhereInput {
  return { OR: [{ hasheousCheckedAt: null }, { hasheousCheckedAt: { lt: cutoff } }] };
}

export async function selectPullCandidates(env: HasheousEnv): Promise<{
  needs: PullCandidate[];
  refresh: PullCandidate[];
}> {
  const now = Date.now();
  const recheckCutoff = new Date(now - NOT_FOUND_RECHECK_MS);
  const refreshCutoff = new Date(now - SYNCED_REFRESH_MS);

  const needs = await prisma.submission.findMany({
    where: {
      status: 'APPROVED',
      deletedAt: null,
      OR: [
        // A push awaiting verification is checked every cycle, NOT held to
        // the cooldown: this is what makes push verification happen
        // automatically (a fully-synced row would otherwise never be
        // looked at again, so a push made after that point would never be
        // verified no matter how long you waited).
        { gameMapping: { hasheousPushStatus: 'pending' } },
        {
          AND: [
            {
              OR: [
                // Never successfully pulled — see NEEDS_FIRST_SYNC_CLAUSES for
                // why this is NOT just `status != 'ok'` (NULL-status rows).
                ...NEEDS_FIRST_SYNC_CLAUSES,
                // A row pulled BEFORE IGDB slug-fetching existed has igdbId
                // set but igdbSlug null and would otherwise stay "IGDB 12345
                // (no direct link)" forever, since status='ok' excludes it.
                { gameMapping: { igdbId: { not: null }, igdbSlug: null } },
                // Synced against a different Hasheous environment than the
                // one configured now (beta vs production are separate
                // databases with different ids) — or from an import that
                // carried a hasheousId but no env. Re-pull fixes the id/env
                // the "Synced with Hasheous" link is built from. `not: env`
                // alone would skip NULL, hence the explicit null clause.
                {
                  gameMapping: {
                    hasheousId: { not: null },
                    OR: [{ hasheousEnv: null }, { hasheousEnv: { not: env } }],
                  },
                },
              ],
            },
            dueBefore(recheckCutoff),
          ],
        },
      ],
    },
    select: PULL_SELECT,
    orderBy: PULL_ORDER,
    take: PULL_BATCH,
  });

  const refresh = await prisma.submission.findMany({
    where: {
      status: 'APPROVED',
      deletedAt: null,
      id: { notIn: needs.map((n) => n.id) },
      gameMapping: { hasheousSyncStatus: 'ok', hasheousId: { not: null } },
      ...dueBefore(refreshCutoff),
    },
    select: PULL_SELECT,
    orderBy: PULL_ORDER,
    take: REFRESH_BATCH,
  });

  return { needs, refresh };
}

async function runAutoPull() {
  if (!process.env.HASHEOUS_ENV && !process.env.HASHEOUS_API_KEY) return; // not configured
  // A cycle (or a previous one that's still crawling through a slow
  // Hasheous) must never overlap the next — two runs would double the
  // request rate and race each other's writes.
  if (globalThis.__hasheousPullRunning) {
    console.log('[hasheous/auto-pull] previous cycle still running — skipping this tick');
    return;
  }
  globalThis.__hasheousPullRunning = true;
  try {
    await runAutoPullCycle();
  } finally {
    globalThis.__hasheousPullRunning = false;
  }
}

async function runAutoPullCycle() {
  const env = getEnv();
  const { needs, refresh } = await selectPullCandidates(env);
  const entries = [...needs, ...refresh];

  if (entries.length === 0) return;
  console.log(`[hasheous/auto-pull] ${needs.length} to sync/re-check + ${refresh.length} refresh (${env})`);

  const job = await prisma.syncJob.create({
    data: { direction: 'PULL', env, status: 'RUNNING', triggeredBy: 'SCHEDULER', total: entries.length },
  });
  let found = 0, updated = 0, notFound = 0, processed = 0, failedLookups = 0, consecutiveErrors = 0;

  try {
    for (let i = 0; i < entries.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, PULL_DELAY_MS));
      const sub = entries[i];
      processed++;
      const result = await pullMappingForSubmission(sub, env);
      if (result.error) {
        // A FAILED lookup is not a "not found" — it isn't counted as one,
        // and (see pullMappingForSubmission) it isn't remembered as checked,
        // so the next cycle retries it.
        failedLookups++;
        consecutiveErrors++;
        console.error(`[hasheous/auto-pull] error on ${sub.hackName}:`, result.error);
        if (consecutiveErrors >= MAX_CONSECUTIVE_LOOKUP_ERRORS) {
          // Hasheous is down / rate-limiting everything — stop instead of
          // spending the rest of the batch (each failure can cost ~3 tries).
          throw new Error(
            `Stopped after ${consecutiveErrors} lookups in a row failed (last: ${result.error}). The remaining entries will be retried next cycle.`
          );
        }
        continue;
      }
      consecutiveErrors = 0;
      if (!result.found) { notFound++; continue; }
      found++;
      if (result.updated) updated++;
    }
    await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status: 'DONE', finishedAt: new Date(), processed, found, updated, notFound,
        errorMessage: failedLookups > 0
          ? `${failedLookups} lookup(s) failed (Hasheous unreachable, slow or rate-limited) and will be retried next cycle`
          : null,
      },
    });
    console.log(`[hasheous/auto-pull] done: ${found} found (${updated} updated), ${notFound} not found, ${failedLookups} failed`);
  } catch (err: any) {
    console.error(`[hasheous/auto-pull] stopped early after ${processed}/${entries.length}: ${err?.message ?? err}`);
    await prisma.syncJob.update({
      where: { id: job.id },
      data: { status: 'ERROR', finishedAt: new Date(), errorMessage: err?.message ?? 'Unknown error', processed, found, updated, notFound },
    }).catch(() => {});
  }
}

async function runAutoPush() {
  const key = process.env.HASHEOUS_API_KEY;
  if (!key) return; // push requires API key
  const env = getEnv();

  const entries = await prisma.submission.findMany({
    where: {
      status: 'APPROVED',
      deletedAt: null,
      gameMapping: {
        hasheousSyncStatus: 'ok',
        hasheousId: { not: null },
        // Never re-push something already confirmed matching on Hasheous's
        // end (see hasheousSync.ts's verification logic) — there's nothing
        // new to tell them. AND don't re-push something pushed within the
        // last 24h that's still pending confirmation — Hasheous's own
        // estimate for processing a push is ~24h, so re-sending the exact
        // same data before that's elapsed is just noise, and (important for
        // the verification feature) would keep resetting hasheousPushedAt,
        // which would mean the 48h "flag it as not reflected" grace period
        // in hasheousSync.ts could never actually be reached.
        hasheousPushStatus: { not: 'confirmed' },
        AND: [
          {
            // At least one mapping ID must be present to be worth pushing
            OR: [
              { igdbId: { not: null } },
              { theGamesDBId: { not: null } },
              { launchboxId: { not: null } },
              { retroAchievementsId: { not: null } },
              { giantBombId: { not: null } },
              { screenScraperId: { not: null } },
              { steamGridDBId: { not: null } },
              { gogId: { not: null } },
              { epicGamesId: { not: null } },
            ],
          },
          {
            OR: [
              { hasheousPushedAt: null },
              { hasheousPushedAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
            ],
          },
        ],
      },
    },
    select: { id: true, sha1: true, md5: true, crc32: true, hackName: true, gameMapping: true },
    take: PUSH_BATCH,
  });

  if (entries.length === 0) return;
  console.log(`[hasheous/auto-push] pushing ${entries.length} entries (${env})`);

  const job = await prisma.syncJob.create({
    data: { direction: 'PUSH', env, status: 'RUNNING', triggeredBy: 'SCHEDULER', total: entries.length },
  });
  let pushed = 0, failed = 0;

  for (let i = 0; i < entries.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, PUSH_DELAY_MS));
    const sub = entries[i];
    const m = sub.gameMapping as any;
    const mappingsToSend = {
      igdbId: m.igdbId ?? undefined,
      theGamesDBId: m.theGamesDBId ?? undefined,
      giantBombId: m.giantBombId ?? undefined,
      launchboxId: m.launchboxId ?? undefined,
      screenScraperId: m.screenScraperId ?? undefined,
      steamGridDBId: m.steamGridDBId ?? undefined,
      retroAchievementsId: m.retroAchievementsId ?? undefined,
      gogId: m.gogId ?? undefined,
      epicGamesId: m.epicGamesId ?? undefined,
    };
    try {
      const result = await pushMappingToHasheous({
        hashes: { crc32: sub.crc32, md5: sub.md5, sha1: sub.sha1 },
        mappings: mappingsToSend,
      }, env);
      if (result.ok) {
        pushed++;
        await recordAcceptedPushResult(m.id, mappingsToSend, result);
      } else {
        failed++;
      }
    } catch (err: any) {
      failed++;
      console.error(`[hasheous/auto-push] error on ${sub.hackName}:`, err?.message);
    }
  }

  await prisma.syncJob.update({
    where: { id: job.id },
    data: { status: 'DONE', finishedAt: new Date(), processed: entries.length, pushed, failed },
  });

  console.log(`[hasheous/auto-push] done`);
}

export function startSyncScheduler() {
  // Only run in a real server environment, not during builds or test runs
  if (
    globalThis.__hasheousSyncStarted ||
    process.env.NODE_ENV === 'test' ||
    typeof window !== 'undefined'
  ) return;

  globalThis.__hasheousSyncStarted = true;

  // AUG-24: loud, once-per-boot log of which Hasheous environment this
  // deployment is actually talking to. Added after a real incident: this
  // project's own repo .env had HASHEOUS_ENV="production", but that file is
  // excluded from the Docker image by .dockerignore, and DOCKER_PORTAINER_
  // GUIDE.md's environment-variables setup table never listed HASHEOUS_ENV
  // (or HASHEOUS_API_KEY) at all — it predates the Hasheous integration and
  // was never updated. Net effect: the deployed container had been silently
  // falling back to docker-compose.yml/portainer-stack.yml's
  // `${HASHEOUS_ENV:-beta}` default this whole time, with zero errors —
  // every pull and push went to beta.hasheous.org while corrections were
  // being made on the real hasheous.org, so nothing could ever line up.
  // Confirmed directly from a Force re-check log the user pasted
  // (`env=beta`) against their own repo .env (`HASHEOUS_ENV="production"`).
  // This makes that specific failure mode visible on every single boot from
  // now on, instead of only discoverable by noticing a mismatch between a
  // diagnostic log line and a deployment file.
  const resolvedEnv = getEnv();
  console.log(
    process.env.HASHEOUS_ENV
      ? `[hasheous] environment: ${resolvedEnv} (HASHEOUS_ENV explicitly set) → ${getHasheousBaseUrl(resolvedEnv)}`
      : `[hasheous] WARNING: HASHEOUS_ENV is not set in this container's environment — silently defaulting to '${resolvedEnv}' (${getHasheousBaseUrl(resolvedEnv)}). If corrections made directly on Hasheous's real site aren't showing up here, this is almost certainly why. Set HASHEOUS_ENV explicitly wherever this stack's environment variables are configured (see DOCKER_PORTAINER_GUIDE.md) — a repo .env file alone is NOT enough, it's excluded from the image by .dockerignore.`
  );

  // Run once on startup (after a short delay to let the DB settle)
  setTimeout(() => {
    runAutoPull().catch(console.error);
  }, 15000); // 15s after server start

  // Then on schedule
  setInterval(() => { runAutoPull().catch(console.error); }, PULL_INTERVAL_MS);
  setInterval(() => { runAutoPush().catch(console.error); }, PUSH_INTERVAL_MS);

  console.log(
    `[hasheous] auto-sync scheduler started (pull every ${PULL_INTERVAL_MS / 3600000}h: unresolved entries re-asked every ${NOT_FOUND_RECHECK_MS / 3600000}h, synced entries refreshed every ${SYNCED_REFRESH_MS / 86400000}d; push every ${PUSH_INTERVAL_MS / 60000}min)`
  );
}
