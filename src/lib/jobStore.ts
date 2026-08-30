// src/lib/jobStore.ts
//
// The job store is pinned to `globalThis` instead of a plain module-level
// variable. In Next.js dev mode, modules are re-evaluated on every hot
// reload (triggered by any file save anywhere in the project). A plain
// `const store = new Map()` resets to an empty Map on every reload, which
// is why jobs were disappearing after 70–100 requests — that's roughly how
// long a long-running pull takes before an unrelated file save triggers a
// reload and loses the Map entirely.
//
// `globalThis` survives module re-evaluation within the same Node process.
// In production (`npm run build && npm start`) hot reload doesn't exist, so
// this guard has no effect there — it's purely a dev-mode quality-of-life
// fix.

export interface JobEntry {
  id: string;
  hackName: string;
  sha1: string;
  mappingsApplied?: string[];
  error?: string;
}

export interface HasheousPullJob {
  id: string;
  status: 'pending' | 'running' | 'done' | 'error';
  env: string;
  total: number;
  processed: number;
  found: number;
  updated: number;
  notFound: number;
  startedAt: string;
  finishedAt?: string;
  foundResults: JobEntry[];
  notFoundResults: JobEntry[];
}

// Declare on globalThis so TypeScript doesn't complain
declare global {
  // eslint-disable-next-line no-var
  var __hasheousJobStore: Map<string, HasheousPullJob> | undefined;
}

function getStore(): Map<string, HasheousPullJob> {
  if (!globalThis.__hasheousJobStore) {
    globalThis.__hasheousJobStore = new Map();
  }
  return globalThis.__hasheousJobStore;
}

export const jobStore = {
  create(id: string, total: number, env: string): HasheousPullJob {
    const store = getStore();
    const job: HasheousPullJob = {
      id, env, status: 'pending', total, processed: 0,
      found: 0, updated: 0, notFound: 0,
      startedAt: new Date().toISOString(),
      foundResults: [], notFoundResults: [],
    };
    store.set(id, job);
    // Keep the last 20 jobs — older ones are probably irrelevant
    if (store.size > 20) {
      const oldest = store.keys().next().value;
      if (oldest) store.delete(oldest);
    }
    return job;
  },

  get(id: string): HasheousPullJob | undefined {
    return getStore().get(id);
  },

  update(id: string, fn: (job: HasheousPullJob) => void) {
    const store = getStore();
    const job = store.get(id);
    if (job) { fn(job); store.set(id, job); }
  },

  list(): HasheousPullJob[] {
    return Array.from(getStore().values()).sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
  },
};
