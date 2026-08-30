// instrumentation.ts
// Next.js's official hook for running code once when the server starts.
// See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
//
// This file must be in the project root (next to package.json), not in src/.
// It's called automatically by Next.js 14+ when the server initialises.

export async function register() {
  // Only run on the server side (Next.js also calls this hook in the
  // Edge runtime for middleware; we only want this in Node)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startSyncScheduler } = await import('./src/lib/syncScheduler');
    startSyncScheduler();
  }
}
