// src/lib/rateLimit.ts
//
// Rate limiting for POST /api/submissions, POST+DELETE
// /api/submissions/[id]/verify, and GET /api/search — Upstash Redis (REST,
// not a TCP connection — works fine from behind Nginx Proxy Manager +
// Cloudflare with nothing extra to open) via @upstash/ratelimit.
//
// CONFIG IS OPTIONAL, ON PURPOSE: if UPSTASH_REDIS_REST_URL/TOKEN aren't
// set, rate limiting is simply OFF and these three endpoints behave exactly
// as they did before this file existed — this is the same "gracefully
// degrade a not-yet-configured optional integration instead of crashing the
// app" pattern already used for DISCORD_CLIENT_ID (src/lib/auth.ts) and
// HASHEOUS_API_KEY. Safe for local dev; should actually be set before the
// public launch, since that's the whole point of this file.

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { NextRequest, NextResponse } from 'next/server';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export const rateLimitingEnabled = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

if (!rateLimitingEnabled) {
  // This module is only ever evaluated once per server process (same
  // singleton-on-import behavior as src/lib/prisma.ts) — this warning logs
  // once at boot, not once per request.
  console.warn(
    '[rateLimit] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — ' +
      'rate limiting is DISABLED. /api/submissions, /api/submissions/[id]/verify, ' +
      'and /api/search are currently unlimited. Set both (see .env.example) before going public.'
  );
}

// globalThis-cached for the same reason src/lib/prisma.ts caches its client
// — avoids constructing a fresh Redis client (and three fresh Ratelimit
// instances) on every hot-reload in dev.
const g = globalThis as unknown as {
  __hackhashRedis?: Redis | null;
  __hackhashRatelimiters?: {
    submissions: Ratelimit;
    verify: Ratelimit;
    search: Ratelimit;
  } | null;
};

const redis: Redis | null =
  g.__hackhashRedis !== undefined ? g.__hackhashRedis : rateLimitingEnabled ? Redis.fromEnv() : null;

if (process.env.NODE_ENV !== 'production') g.__hackhashRedis = redis;

const limiters =
  g.__hackhashRatelimiters !== undefined
    ? g.__hackhashRatelimiters
    : redis
    ? {
        // Creating a submission is the real abuse/spam vector (each one
        // writes a Submission row, possibly a GameMapping row, and can
        // trigger Hasheous pull/push) — this route is already auth-gated
        // (see route.ts), so an unauthenticated flood is already rejected
        // by the existing 401 check before it ever reaches this limiter.
        // Keyed by user id, not IP: the thing worth throttling here is one
        // account submitting too fast, and IP-keying would incorrectly
        // punish everyone behind the same NAT/office/VPN exit as a genuine
        // spammer. 10 per 10 minutes is a starting point, not a researched
        // number — trivial to tune, see checkSubmissionsRateLimit's caller.
        submissions: new Ratelimit({
          redis,
          limiter: Ratelimit.slidingWindow(10, '10 m'),
          analytics: true,
          prefix: 'ratelimit:submissions',
        }),
        // Same reasoning as submissions (auth-gated already, key by user id
        // not IP) — but a verify/vote action is cheaper and a genuinely
        // active reviewer might click through many pending submissions in
        // one sitting, so this is deliberately more generous than
        // submissions. Also covers DELETE (removing a verification) — both
        // read from the SAME counter via the same identifier, since either
        // one is "this user changing verification state."
        verify: new Ratelimit({
          redis,
          limiter: Ratelimit.slidingWindow(30, '10 m'),
          analytics: true,
          prefix: 'ratelimit:verify',
        }),
        // No auth at all on this route (see route.ts) — IP is the only
        // identifier available, via getClientIp() below. This runs on
        // every keystroke of the search box (debounced client-side — see
        // SearchInterface.tsx), and each request can fan out into up to 4
        // parallel Prisma queries with no index-backed pagination beyond an
        // internal take:50 — the endpoint most worth protecting from
        // scraping, not just from "too many people typing."
        search: new Ratelimit({
          redis,
          limiter: Ratelimit.slidingWindow(30, '10 s'),
          analytics: true,
          prefix: 'ratelimit:search',
        }),
      }
    : null;

if (process.env.NODE_ENV !== 'production') g.__hackhashRatelimiters = limiters;

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  /** Unix ms timestamp when the window resets. 0 when rate limiting is disabled. */
  reset: number;
}

const UNLIMITED: RateLimitResult = { success: true, limit: Number.POSITIVE_INFINITY, remaining: Number.POSITIVE_INFINITY, reset: 0 };

async function check(limiter: Ratelimit | undefined, identifier: string): Promise<RateLimitResult> {
  if (!limiter) return UNLIMITED;
  return limiter.limit(identifier);
}

export function checkSubmissionsRateLimit(identifier: string): Promise<RateLimitResult> {
  return check(limiters?.submissions, identifier);
}

export function checkVerifyRateLimit(identifier: string): Promise<RateLimitResult> {
  return check(limiters?.verify, identifier);
}

export function checkSearchRateLimit(identifier: string): Promise<RateLimitResult> {
  return check(limiters?.search, identifier);
}

/**
 * Best-effort client IP for the search route (the only one of the three
 * with no session to key off instead). This deployment sits behind
 * Cloudflare -> Nginx Proxy Manager -> this container (see
 * DOCKER_PORTAINER_GUIDE.md / CLAUDE_HANDOFF.txt) — checked in that order:
 *
 * 1. CF-Connecting-IP — set by Cloudflare to the real visitor IP whenever
 *    the zone is proxied (orange-cloud). Most trustworthy source in this
 *    exact stack; not something a client can spoof past Cloudflare's edge.
 * 2. X-Forwarded-For (first entry) — fallback for a non-Cloudflare-proxied
 *    request (grey-cloud/DNS-only, LAN access, or a future deployment
 *    without Cloudflare in front). Correct as long as Nginx Proxy Manager
 *    is appending rather than replacing this header, which is its default.
 * 3. X-Real-IP — one more common reverse-proxy convention, checked last.
 * 4. 'unknown' — bucketing every unidentified request together is safer
 *    than throwing, but means this limiter won't meaningfully distinguish
 *    visitors if NONE of the above are ever present. If search rate limits
 *    seem to trigger for everyone at once in production, check whether NPM
 *    is actually forwarding these headers before assuming the limits
 *    themselves are wrong.
 */
export function getClientIp(req: NextRequest): string {
  const cfIp = req.headers.get('cf-connecting-ip');
  if (cfIp) return cfIp;

  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim();
    if (first) return first;
  }

  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp;

  return 'unknown';
}

/** Standard 429 response, headers matching the RatelimitResult that produced it. */
export function rateLimitedResponse(result: RateLimitResult): NextResponse {
  const retryAfterSeconds = Math.max(0, Math.ceil((result.reset - Date.now()) / 1000));
  return NextResponse.json(
    { error: 'Too many requests — please slow down and try again shortly.' },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSeconds),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(result.reset),
      },
    }
  );
}
