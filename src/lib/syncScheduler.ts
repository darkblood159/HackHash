// src/lib/syncScheduler.ts
//
// Background scheduler for automatic Hasheous sync. Pinned to globalThis so
// it survives Next.js dev-mode hot reloads (same pattern as jobStore.ts).
//
// Two operations run on separate intervals:
//
//   PULL (every 6 hours): Scans for approved entries with no successful
//   Hasheous sync yet, processes up to 200 at a time at 800ms/request.
//   This handles the "incremental catch-up" case — new entries added since
//   the last big manual pull, or entries that previously timed out.
//
//   PUSH (every 30 minutes): Scans for approved entries whose GameMapping
//   has mapping IDs but hasn't been pushed to Hasheous yet. This handles
//   the "new data entered via UI after the last manual push" case.
//
// Both are deliberately conservative — they only touch a small batch per
// cycle to avoid hammering Hasheous, and they skip anything already confirmed
// synced. The manual pull/push remain available for big one-off operations.
//
// The scheduler starts on the first call to startSyncScheduler(), which is
// called from the layout on the first real API request. It does nothing in
// test/build environments.

import { prisma } from './prisma';
import { pushMappingToHasheous, getHasheousBaseUrl, type HasheousEnv } from './hasheous';
import { pullMappingForSubmission, recordAcceptedPushResult } from './hasheousSync';

declare global {
  // eslint-disable-next-line no-var
  var __hasheousSyncStarted: boolean | undefined;
}

const PULL_INTERVAL_MS  = 6 * 60 * 60 * 1000;  // 6 hours
const PUSH_INTERVAL_MS  = 30 * 60 * 1000;        // 30 minutes
const PULL_BATCH        = 200;
const PUSH_BATCH        = 50;
const PULL_DELAY_MS     = 800;
const PUSH_DELAY_MS     = 500;

function getEnv(): HasheousEnv {
  return (process.env.HASHEOUS_ENV as HasheousEnv | undefined) ?? 'beta';
}

async function runAutoPull() {
  if (!process.env.HASHEOUS_ENV && !process.env.HASHEOUS_API_KEY) return; // not configured
  const env = getEnv();

  const entries = await prisma.submission.findMany({
    where: {
      status: 'APPROVED',
      deletedAt: null,
      OR: [
        { gameMappingId: null },
        { gameMapping: { hasheousSyncStatus: { not: 'ok' } } },
        // This is the piece that makes push verification actually happen
        // automatically: without it, a submission that's already fully
        // synced (hasheousSyncStatus='ok') is excluded by the condition
        // above and the scheduler would never look at it again — so a
        // PUSH made after that point would never get checked, no matter
        // how long you waited. This re-includes anything with an
        // unconfirmed push so pullMappingForSubmission's verification
        // logic (see hasheousSync.ts) gets a chance to run on it.
        { gameMapping: { hasheousPushStatus: 'pending' } },
        // Same reasoning as above, different symptom: a row pulled BEFORE
        // IGDB slug-fetching existed has igdbId set but igdbSlug null, and
        // — without this — would never be revisited to backfill it, since
        // hasheousSyncStatus='ok' already excludes it via the condition
        // above. This is what was actually causing "IGDB 12345 (no direct
        // link)" to persist indefinitely for older entries even after slug
        // resolution was added: the code to fetch it was correct, it just
        // never got a chance to run again for anything already synced.
        { gameMapping: { igdbId: { not: null }, igdbSlug: null } },
      ],
    },
    select: { id: true, sha1: true, md5: true, crc32: true, hackName: true, gameMappingId: true },
    orderBy: { createdAt: 'desc' }, // newest first — new approvals get picked up faster
    take: PULL_BATCH,
  });

  if (entries.length === 0) return;
  console.log(`[hasheous/auto-pull] processing ${entries.length} unsynced entries (${env})`);

  const job = await prisma.syncJob.create({
    data: { direction: 'PULL', env, status: 'RUNNING', triggeredBy: 'SCHEDULER', total: entries.length },
  });
  let found = 0, updated = 0, notFound = 0, processed = 0;

  try {
    for (let i = 0; i < entries.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, PULL_DELAY_MS));
      const sub = entries[i];
      processed++;
      const result = await pullMappingForSubmission(sub, env);
      if (result.error) {
        console.error(`[hasheous/auto-pull] error on ${sub.hackName}:`, result.error);
        continue;
      }
      if (!result.found) { notFound++; continue; }
      found++;
      if (result.updated) updated++;
    }
    await prisma.syncJob.update({
      where: { id: job.id },
      data: { status: 'DONE', finishedAt: new Date(), processed, found, updated, notFound },
    });
  } catch (err: any) {
    await prisma.syncJob.update({
      where: { id: job.id },
      data: { status: 'ERROR', finishedAt: new Date(), errorMessage: err?.message ?? 'Unknown error', processed, found, updated, notFound },
    }).catch(() => {});
  }

  console.log(`[hasheous/auto-pull] done`);
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

  console.log('[hasheous] auto-sync scheduler started (pull every 6h, push every 30min)');
}
