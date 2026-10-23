// src/lib/hasheousIngestWatch.ts
//
// Knows WHEN Hasheous has digested HackHash's DAT export, so the scheduler can
// re-check already-synced entries at the moment it matters instead of on each
// row's own unrelated 7-day clock (see the long comment in syncConfig.ts).
//
// Source of truth: GET {hasheous}/api/v1.0/BackgroundTasks. Read from
// Hasheous's own source (BackgroundTasksController.GetQueue is [AllowAnonymous];
// its status page renders exactly this): a JSON object of server-group ->
// array of tasks (`Local`, `Remote`), each task having itemType, itemName,
// itemState, lastRunTime, lastFinishTime, nextRunTime, interval. NOT yet
// confirmed against the live server from here (the sandbox can't reach it),
// so everything below is deliberately defensive and FAILS SOFT: an unreadable
// answer never throws into the scheduler and never starts a wave by accident.
//
// ZERO app imports (only syncConfig, itself import-free) so it can be
// bundled and unit-tested without Prisma, and `decideWave` is a pure function
// of (previous state, snapshot, now).

import {
  WAVE_SETTLE_MS, WAVE_MAX_WAIT_MS, WAVE_STATUS_TIMEOUT_MS,
  HASHEOUS_INGEST_ITEM_NAME, HASHEOUS_MATCH_ITEM_TYPE,
} from './syncConfig';

/** SiteSetting key holding the JSON-encoded WaveState. */
export const WAVE_SETTING_KEY = 'hasheous_ingest_wave';

/** One Hasheous background task, normalised. Times are epoch ms (UTC) or null. */
export interface TaskSnap {
  name: string;
  type: string;
  state: string; // 'NeverStarted' | 'Running' | 'Stopped' | 'Disabled' (or whatever Hasheous sends)
  lastRunTime: number | null;
  lastFinishTime: number | null;
  nextRunTime: number | null;
}

export interface HasheousSchedule {
  /** HackHash's own import task (null when this Hasheous env doesn't list one). */
  ingest: TaskSnap | null;
  /** Hasheous's daily metadata-match task. */
  matchSearch: TaskSnap | null;
}

/** Persisted (JSON in SiteSetting). All times ISO-8601 UTC. */
export interface WaveState {
  /** Finish time of the Hasheous import this wave belongs to — its identity. */
  ingestFinishedAt: string;
  /** When HackHash first saw that import. */
  armedAt: string;
  /** When the wave became due; entries last checked BEFORE this are re-checked. Null = still waiting. */
  readyAt: string | null;
  /** Set once every already-synced entry has been re-checked. */
  completedAt: string | null;
}

export interface WaveDecision {
  next: WaveState | null;
  changed: boolean;
  /** Short human-readable reason, for the log; empty when nothing happened. */
  reason: string;
}

const STATE_BY_NUMBER = ['NeverStarted', 'Running', 'Stopped', 'Disabled'];
/** Tolerated clock skew between Hasheous and this server for "finished in the future". */
const SKEW_MS = 5 * 60 * 1000;

function pick(o: Record<string, unknown>, key: string): unknown {
  const want = key.toLowerCase();
  for (const k of Object.keys(o)) if (k.toLowerCase() === want) return o[k];
  return undefined;
}

// .NET can hand back a DateTime with Kind=Unspecified (no "Z"), which
// Date.parse would read as SERVER-LOCAL time. Hasheous only ever writes
// UtcNow, so a designator-less string is UTC.
function parseTime(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(v);
  const t = Date.parse(hasZone ? v : `${v}Z`);
  // .NET's DateTime.MinValue ("0001-01-01…") means "never" — treat as null.
  if (!Number.isFinite(t) || t < Date.parse('2000-01-01T00:00:00Z')) return null;
  return t;
}

function normState(v: unknown): string {
  if (typeof v === 'number') return STATE_BY_NUMBER[v] ?? String(v);
  return typeof v === 'string' ? v : '';
}

function toSnap(o: Record<string, unknown>): TaskSnap {
  return {
    name: String(pick(o, 'itemName') ?? ''),
    type: String(pick(o, 'itemType') ?? ''),
    state: normState(pick(o, 'itemState')),
    lastRunTime: parseTime(pick(o, 'lastRunTime')),
    lastFinishTime: parseTime(pick(o, 'lastFinishTime')),
    nextRunTime: parseTime(pick(o, 'nextRunTime')),
  };
}

function latest(snaps: TaskSnap[]): TaskSnap | null {
  if (snaps.length === 0) return null;
  return snaps.reduce((a, b) => ((b.lastFinishTime ?? 0) > (a.lastFinishTime ?? 0) ? b : a));
}

/** Pure: Hasheous's task-list JSON -> the two tasks we care about. Never throws. */
export function parseBackgroundTasks(json: unknown): HasheousSchedule {
  const items: TaskSnap[] = [];
  const collect = (arr: unknown[]) => {
    for (const el of arr) {
      if (el && typeof el === 'object' && !Array.isArray(el)) items.push(toSnap(el as Record<string, unknown>));
    }
  };
  if (Array.isArray(json)) collect(json);
  else if (json && typeof json === 'object') {
    for (const v of Object.values(json as Record<string, unknown>)) if (Array.isArray(v)) collect(v);
  }
  const wantName = HASHEOUS_INGEST_ITEM_NAME.toLowerCase();
  const wantType = HASHEOUS_MATCH_ITEM_TYPE.toLowerCase();
  return {
    ingest: latest(items.filter((t) => t.name.toLowerCase() === wantName)),
    matchSearch: latest(items.filter((t) => t.type.toLowerCase() === wantType || t.name.toLowerCase() === wantType)),
  };
}

/** One anonymous GET of Hasheous's task list. Never throws. */
export async function fetchHasheousSchedule(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; schedule: HasheousSchedule } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WAVE_STATUS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${baseUrl}/api/v1.0/BackgroundTasks`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, schedule: parseBackgroundTasks(await res.json()) };
  } catch (err: any) {
    return { ok: false, error: err?.name === 'AbortError' ? 'timed out' : (err?.message ?? 'request failed') };
  } finally {
    clearTimeout(timer);
  }
}

/** Is a wave currently due to run (ready, not finished)? */
export function isWaveActive(w: WaveState | null): w is WaveState & { readyAt: string } {
  return !!w && !!w.readyAt && !w.completedAt;
}

/** Pure parse+validate of the persisted JSON; anything malformed is "no wave". */
export function parseWaveState(raw: string | null | undefined): WaveState | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    const iso = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
    if (!iso(o?.ingestFinishedAt) || !iso(o?.armedAt)) return null;
    return {
      ingestFinishedAt: o.ingestFinishedAt,
      armedAt: o.armedAt,
      readyAt: iso(o.readyAt) ? o.readyAt : null,
      completedAt: iso(o.completedAt) ? o.completedAt : null,
    };
  } catch {
    return null;
  }
}

/**
 * Pure state machine. Arms a wave when Hasheous has FINISHED an import newer
 * than the one we last acted on; makes it ready once Hasheous's metadata-match
 * run has started AFTER that import and finished, plus the settle delay (or
 * after the max wait as a fallback). It never un-arms or reorders anything.
 */
export function decideWave(prev: WaveState | null, sched: HasheousSchedule, now: number): WaveDecision {
  let wave = prev;
  const notes: string[] = [];

  const ing = sched.ingest;
  if (ing && ing.state === 'Stopped' && ing.lastFinishTime != null && ing.lastFinishTime <= now + SKEW_MS) {
    const known = prev ? Date.parse(prev.ingestFinishedAt) : -Infinity;
    if (ing.lastFinishTime > known) {
      wave = {
        ingestFinishedAt: new Date(ing.lastFinishTime).toISOString(),
        armedAt: new Date(now).toISOString(),
        readyAt: null,
        completedAt: null,
      };
      notes.push(`Hasheous finished importing HackHash's DAT at ${wave.ingestFinishedAt}`);
    }
  }

  if (wave && !wave.completedAt && !wave.readyAt) {
    const fin = Date.parse(wave.ingestFinishedAt);
    const m = sched.matchSearch;
    const matchDone =
      !!m && m.state === 'Stopped' &&
      m.lastRunTime != null && m.lastFinishTime != null &&
      m.lastRunTime > fin && m.lastFinishTime >= m.lastRunTime &&
      now >= m.lastFinishTime + WAVE_SETTLE_MS;
    if (matchDone) {
      wave = { ...wave, readyAt: new Date(now).toISOString() };
      notes.push('Hasheous metadata match has run since the import and its caches have settled — wave starts');
    } else if (now >= fin + WAVE_MAX_WAIT_MS) {
      wave = { ...wave, readyAt: new Date(now).toISOString() };
      notes.push('no finished Hasheous match run seen within the max wait — wave starts anyway');
    }
  }

  const changed = JSON.stringify(wave) !== JSON.stringify(prev);
  return { next: wave, changed, reason: notes.join('; ') };
}
