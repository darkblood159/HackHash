# ROMHack DAT

A community-driven DAT database for ROM hacks, fan translations, homebrew, and preservation
projects — built like a cross between No-Intro, Redump, and Wikipedia moderation.

**The ROM file is never uploaded.** All hashing (CRC32, MD5, SHA-1) happens in the browser.
Only the resulting metadata is sent to the server.

---

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 14 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS |
| Database | PostgreSQL |
| ORM | Prisma |
| Auth | NextAuth (GitHub + Discord OAuth) |
| Hashing | Browser-side: Web Crypto API (SHA-1), SparkMD5 (MD5), custom CRC32 |

---

## Architecture

```
src/
├── app/
│   ├── page.tsx                      Homepage — hero + live hashing demo
│   ├── submit/                       Submission flow (hash → metadata → review)
│   ├── submissions/                  Review queue + individual submission detail
│   ├── entries/                      Master DAT browse + export (XML/JSON/CSV)
│   ├── search/                       Hash / name lookup
│   ├── profile/[id]/                 User profile, trust history
│   ├── admin/                        Moderation dashboard (submissions, users)
│   ├── auth/                         Sign-in / error pages
│   └── api/                          Route handlers (see below)
├── components/
│   ├── ROMProcessor.tsx              Core browser-side hashing engine + drop zone
│   ├── SubmitForm.tsx                Multi-step submission form
│   ├── VerifyPanel.tsx               Re-hash & compare for community verification
│   ├── AdminActions.tsx              Approve / reject / dispute controls
│   └── ui/                           Badges, buttons, avatars, gauges
├── lib/
│   ├── prisma.ts                     Prisma client singleton
│   ├── auth.ts                       NextAuth config
│   ├── trust.ts                      Trust score + verification score engine
│   └── dat-generator.ts              XML / JSON / CSV DAT generation
└── types/                            Shared TypeScript types
```

### API routes

| Route | Methods | Purpose |
|---|---|---|
| `/api/submissions` | GET, POST | List / create submissions |
| `/api/submissions/[id]` | GET, PATCH, DELETE | Submission detail, edit, soft-delete |
| `/api/submissions/[id]/verify` | POST, DELETE | Community verification |
| `/api/submissions/[id]/duplicate` | GET, POST | Duplicate reporting |
| `/api/submissions/[id]/comment` | GET, POST | Discussion thread |
| `/api/admin/submissions` | GET | Moderation queue |
| `/api/admin/submissions/[id]` | POST | Approve / reject / dispute |
| `/api/admin/users` | GET, POST | User management, trust adjustment, bans |
| `/api/entries` | GET | Browse approved master DAT |
| `/api/entries/export` | GET | Export DAT as `?format=xml\|json\|csv` |
| `/api/search` | GET | Unified hash/name search |
| `/api/users/[id]` | GET | Public profile data |

---

## Trust & verification model

This is **not** an anti-cheat system. The burden of proof is distributed across submitters,
verifiers, and admins — see `/about/trust` in the running app for the user-facing explanation.

- **Trust score** — per-user integer, adjusted by `TrustEvent`s (approved submission `+10`,
  rejected `-10`, correct verification `+2`, false verification `-5`, spam `-20`, etc).
- **Verifier weight** — derived from trust tier: New (0–199) = ×1, Trusted (200–699) = ×3,
  Veteran (700+) = ×10.
- **Verification score** — sum of weighted votes on a submission. Crossing admin-configurable
  thresholds (`SiteSetting` rows `community_verified_threshold`, `recommended_threshold`) moves
  a submission through `PENDING → COMMUNITY_VERIFIED → RECOMMENDED`. A negative score flips it
  to `DISPUTED`. Only an admin can reach the terminal states `APPROVED` / `REJECTED`.
- **Reconciliation** — when an admin approves or rejects, every verifier's trust is adjusted
  based on whether their vote matched the final outcome (`reconcileVerifierTrust` in
  `src/lib/trust.ts`).

All of this is editable: thresholds and point values live in the `SiteSetting` table, seeded
with defaults in `prisma/seed.ts`, and read at request time in `src/lib/trust.ts`.

### Auto-approval — separate from the score ladder above

On top of the weighted-score ladder, there are four hard auto-approve triggers, checked after
every new verification (`src/lib/approval.ts`):

1. **A single hash-match from a Veteran-tier user (700+ trust) approves immediately.**
2. **Two hash-matches, at least one from a Trusted-tier+ user (200+ trust), approve.** A lone
   Trusted match alone is deliberately *not* enough — it still needs one more confirming match
   from anyone. (Earlier versions had a bug here: a single Trusted-tier match instant-approved the
   same as a Veteran one. Fixed — Veteran still gets the one-vote shortcut, Trusted needs a
   second voice.)
3. **Three hash-matches from anyone** (this is what catches matches from below-Trusted users —
   Veteran and Trusted-pair cases above never need to reach 3, since rules 1/2 already fire).
4. **Manual votes** — for users who want to vouch for a submission without having the file to
   hash. Eligibility is **Verifier role, Administrator role, or Veteran trust tier (700+)** —
   deliberately not just "Trusted" tier (200+), since that tier requires only points, not any
   role-based vetting. Two "yes" votes approve it; if any "no" vote exists, the bar goes up by one
   "yes" per "no" (1 no → need 3 yes; 2 no → need 4 yes; and so on). A "no" never auto-rejects by
   itself — it only raises what's needed to auto-approve. Admins can still manually reject
   regardless of vote count.

Both the manual admin-approve action and these auto-approve triggers go through the same
`performApprovalInTx()` helper, run inside a single database transaction (ApprovedEntry creation,
status update, every verifier's trust reconciliation, audit log — all atomic). This matters: an
earlier version did these as separate sequential calls, and if any one of them failed partway
through — slow connection, proxy timeout — the submission was left half-approved, and retrying
would immediately fail again on a duplicate-key error from the already-created `ApprovedEntry`.
Wrapping it all in one transaction means a failure rolls back completely, so a retry always
starts clean.

---

## Public DAT export API

This is the endpoint for pulling DAT files programmatically — for your own tooling, a cron job,
or another website's frontend. It's public, unauthenticated, and CORS-open (`Access-Control-Allow-Origin: *`)
specifically so it can be fetched both server-to-server and directly from browser-side JS on
another domain.

```
GET /api/entries/export?format={xml|json|csv}&platform={PLATFORM}
```

- `format` — `xml` (Logiqx-compatible, default), `json`, or `csv`.
- `platform` — optional. Omit for the full combined DAT; set to one of `NES`, `SNES`, `N64`, `GB`,
  `GBC`, `GBA`, `SMS`, `GENESIS`, `PS1`, `ARCADE`, `OTHER` for a single-system DAT, matching how
  No-Intro ships one DAT per system rather than one giant file.

Examples (replace the host with wherever you're running this):

```
https://your-domain.com/api/entries/export?format=xml                  # full DAT, XML
https://your-domain.com/api/entries/export?format=xml&platform=N64     # N64 only, XML
https://your-domain.com/api/entries/export?format=json&platform=SNES   # SNES only, JSON
https://your-domain.com/api/entries/export?format=csv                  # full DAT, CSV
```

It's generated fresh from the database on every request (capped by a 5-minute
`Cache-Control: public, max-age=300` header, so repeated fetches within that window can be served
from a cache instead of hitting the DB every time) — there's no separate "build" step, so polling
this URL periodically is the intended way to stay current. A newly-approved entry shows up here
within 5 minutes of approval, no extra step needed on your end.

```bash
# cron-job-friendly example
curl -o n64.dat "https://your-domain.com/api/entries/export?format=xml&platform=N64"
```

```js
// browser-side, from another site's frontend — works because of the CORS headers
const res = await fetch('https://your-domain.com/api/entries/export?format=json&platform=GBA');
const dat = await res.json();
```

There's also a plain JSON browse/search API if you want structured data without the DAT framing
— `GET /api/entries?platform={PLATFORM}&q={search}` (paginated, `page`/`perPage` params) — but
that one isn't CORS-enabled since it wasn't built for cross-origin use; say the word if you want
that opened up too.



```bash
# 1. Install dependencies
npm install

# 2. Copy env and fill in values
cp .env.example .env
# - DATABASE_URL: your Postgres connection string
# - NEXTAUTH_SECRET: generate with `openssl rand -base64 32`
# - GITHUB_ID / GITHUB_SECRET: from a GitHub OAuth App
#   (callback URL: http://localhost:3000/api/auth/callback/github)
# - INITIAL_ADMIN_EMAIL: the email of the account you want auto-promoted to ADMINISTRATOR

# 3. Push the schema (or run a real migration — see below)
npm run db:push

# 4. Seed default tags + settings
npm run db:seed

# 5. Run it
npm run dev
```

### Keeping your data across future schema changes

`db push` (used above) is fine for the very first setup, but it doesn't keep a migration
history — if a future change isn't trivially compatible, Prisma may ask to reset the whole
database rather than figure out a safe path. To stop that from being a recurring problem, set up
real migration tracking **once**, now:

```bash
npx prisma migrate resolve --applied 0_init
```

This tells Prisma "the schema currently in `prisma/migrations/0_init` has already been applied"
(it has — that's what `db push` just did) without re-running any SQL, and it creates the
`_prisma_migrations` tracking table. Your data is untouched.

From this point on, **use this instead of `db push`** whenever the schema changes:

```bash
npx prisma migrate dev --name short_description_of_the_change
```

This computes just the diff, writes it as a new file under `prisma/migrations/`, and applies it
— preserving existing rows for additive/compatible changes (new columns, new enum values,
relaxing a column from required to optional, etc.), which covers basically everything we've done
so far. For deploying to a server later (including the eventual Docker setup), use
`npm run db:migrate:deploy` instead — it applies any pending migrations without prompting and
without ever trying to generate new ones, which is what you want in production/CI.

### Promoting yourself to admin

Set `INITIAL_ADMIN_EMAIL` in `.env` **before** your first sign-in — the `createUser` event in
`src/lib/auth.ts` checks this on account creation. To promote an existing user after the fact:

```bash
npx prisma studio
# User table → find your row → set role to ADMINISTRATOR
```

---

## Platforms / consoles

Every submission has a required `platform` field (`NES`, `SNES`, `N64`, `GB`, `GBC`, `GBA`,
`SMS`, `GENESIS`, `PS1`, `ARCADE`, `OTHER`) — a real Prisma enum, not a freeform tag, so it can
be filtered and indexed properly. It's distinct from the descriptive `Tag` model (translation,
bug-fix, randomizer, etc.), which still applies across any platform.

This shows up as filter pills on `/submissions`, `/entries`, and the admin queue, and as a
required dropdown on the submit form. The master DAT export also respects it — add
`?platform=N64` to `/api/entries/export` (or pick a platform on `/entries/export`) to get a
single-system DAT, the same way No-Intro ships one DAT per system rather than one giant file.
`ApprovedEntry.platform` is denormalized from the submission at approval time specifically so
that filtered export doesn't need a join.

To add a platform, add it to the `Platform` enum in `prisma/schema.prisma` and to the `PLATFORMS`
array + `PLATFORM_LABELS` map in `src/types/index.ts` — that's the single source of truth the
form, filters, and badges all read from.

---

## Running on a LAN (not just localhost)

Two things matter for this:

1. **Web Crypto needs a secure context.** `crypto.subtle` — used for SHA-1 — doesn't exist in
   the browser at all on plain `http://` unless the host is `localhost`/`127.0.0.1`. Visiting the
   dev server at something like `http://192.0.2.10:3000` will silently break hashing.
   `ROMProcessor.tsx` now detects this and falls back to a pure-JS SHA-1 implementation
   automatically, but if you'd rather have real HTTPS, Next.js 14 supports a built-in dev
   certificate:
   ```bash
   npx next dev --experimental-https
   ```
   Then visit `https://192.0.2.10:3000` and accept the self-signed cert warning once.

2. **NextAuth needs to know which host it's actually being served from.** This is controlled by
   the `AUTH_TRUST_HOST` environment variable (set it to `"true"` in `.env`) — *not* a config
   option in `src/lib/auth.ts`. Worth being precise here since a lot of NextAuth advice online
   describes a `trustHost: true` config field, but that's an Auth.js **v5** thing; this project
   uses next-auth **v4**, where origin detection is hardcoded to check `process.env.AUTH_TRUST_HOST`
   directly (see `node_modules/next-auth/utils/detect-origin.js` if you want to verify yourself).
   Without it set, every callback/redirect is hard-locked to `NEXTAUTH_URL`, which is what causes
   the "redirects back to localhost" symptom when signing in from a LAN IP.

   The remaining catch is GitHub itself: **classic GitHub OAuth Apps only support a single
   callback URL**, not a list. So whichever origin you register
   (`https://192.0.2.10:3000/api/auth/callback/github` or `http://localhost:3000/api/auth/callback/github`)
   is the only one sign-in will work from. If you need both, create two separate OAuth Apps and
   swap `GITHUB_ID`/`GITHUB_SECRET` depending on which origin you're running the app on that
   session.

---

## Running behind a reverse proxy

`AUTH_TRUST_HOST` (see the LAN section above) relies on the proxy correctly forwarding the
original request's protocol and host. If it doesn't, NextAuth can compute the wrong origin, which
shows up as inconsistent sign-in behavior — works in one browser/tab, not another; works
logged-in-already but a fresh session (e.g. a new incognito window) can't sign in or doesn't
persist. For nginx, make sure these are set on the proxied location:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $host;
```

If you're missing `X-Forwarded-Proto` specifically, NextAuth can end up unsure whether the real
request was HTTP or HTTPS, which affects whether it sets the `__Secure-` prefixed session cookie
— and a `__Secure-` cookie silently refuses to be set (or sent) over anything the browser doesn't
consider a secure context. This is the most common cause of "signed in on one browser/window but
not another" when a proxy is involved. Worth checking the literal cookie in DevTools → Application
→ Cookies if sign-in seems to silently not take.

Also: most reverse proxies cap request body size by default (nginx's `client_max_body_size` is
1MB out of the box). The DAT import feature batches its uploads specifically to stay under
typical defaults, but if you're sending large payloads elsewhere and seeing generic network
errors, this is the first thing to check.

## Docker

```bash
cp .env.docker.example .env
# edit .env — at minimum set NEXTAUTH_SECRET, GITHUB_ID, GITHUB_SECRET, POSTGRES_PASSWORD

docker compose up -d --build
```

This runs Postgres and the app together on one Docker network — the app reaches the database via
the service name `db`, not `localhost`. Migrations run automatically on container start
(`docker-entrypoint.sh` runs `prisma migrate deploy` before `npm start`), so as long as you've
already set up real migration history per the section above, schema changes will apply cleanly on
every redeploy without wiping data.

**Caveat — this was written without a way to test-build it.** The sandbox that produced this has
no Docker daemon, so the Dockerfile and compose file are unverified. They deliberately favor
reliability over image size — the runtime image copies the full `node_modules` instead of using
Next.js's trimmed "standalone" output, specifically so the `prisma` CLI is available at startup
for migrations, since Prisma's engine binaries are a common source of breakage with the trimmed
approach. Please try `docker compose up -d --build` and tell me what breaks, if anything — I'd
rather fix a real error than have you debug a Dockerfile I never ran.

 The app
itself (`Dockerfile` for the Next.js service) is the main missing piece; the Postgres side can
already run in Docker independently of the app (see your `docker-compose.yml` for the database).
When this gets built out, expect: a multi-stage `Dockerfile` using `next build`'s standalone
output, a `docker-compose.yml` that runs both the app and Postgres on the same network (so the
app can reach the database by service name instead of `localhost`), and `AUTH_TRUST_HOST` will
keep working unchanged since it just reads request headers regardless of whether the request
arrives directly or through Docker's networking.

---

## Security notes

- **No ROM uploads, enforced by design**: there is no API route, form field, or storage bucket
  that accepts a binary ROM file. Hashing happens in `ROMProcessor.tsx` using `File.slice()` +
  `ArrayBuffer`, entirely client-side.
- **Self-verification blocked** server-side in `/api/submissions/[id]/verify` (`submittedById`
  check), not just hidden in the UI.
- **Terminal-state protection**: approved/rejected submissions reject further verification or
  edits at the API layer.
- **Input validation**: all mutating routes validate with `zod` (hash format regexes, length
  caps, URL shape) before touching the database.
- **Trust floor**: accounts below `-50` trust are blocked from new submissions
  (`src/app/api/submissions/route.ts`).
- **Audit log is append-only** — no route deletes `AuditLog` rows; admin "deletes" of a
  submission are soft (status flips to `REJECTED` with a logged reason).
- **BigInt handling**: file sizes are stored as Postgres `BigInt` and explicitly `.toString()`'d
  before JSON serialization to avoid silent precision loss or serialization crashes.

## User roles

Four roles, not three — `GUEST` was added ahead of `CONTRIBUTOR`. Every new sign-in starts as a
Guest; the first time they successfully submit a hack, the API auto-promotes them to Contributor
and the client refreshes the session (via `useSession().update()`) so the navbar reflects it
immediately, without a re-login. Guests can still do everything a Contributor can — the role is
purely a label until that first contribution.

Admins can also override any user's role directly from `/admin/users`, and can fast-track someone
into the Trusted (200+) or Veteran (700+) trust tier with one click, or apply a custom point
adjustment — both backed by the same trust-event system described above, just admin-triggered
instead of earned through approvals/verifications.

## Renaming an approved submission

Mistakes happen — a typo in the hack name, the wrong version string, whatever. On any submission
detail page, admins get an "Edit / rename" panel regardless of status. If the submission is
already `APPROVED`, changing the hack name, version, or platform also updates the live
`ApprovedEntry` (the thing actually exported in the DAT) in the same transaction — so the rename
isn't just cosmetic on the submission page while the exported DAT still has the old name. If the
new name collides with an existing DAT entry, the save fails with a clear error instead of
silently overwriting something.

## Importing an existing DAT

`/admin/import` (admin-only) takes a Logiqx-style DAT XML file — or this site's own JSON export
format — and bulk-creates entries as already-`APPROVED`, skipping the community review queue
entirely. The reasoning: if you already trust a DAT enough to import it wholesale, re-running it
through community verification doesn't add anything.

How it works:
1. The file is parsed entirely in your browser (`src/lib/dat-parser.ts`) — DOMParser for XML,
   `JSON.parse` for JSON. These files only ever contain hashes and names, never ROM data, so this
   doesn't conflict with the "ROMs never touch the server" rule — there's nothing to protect here.
2. You pick one `Platform` for the whole file, since standard DATs are one file per system. Hack
   name and version are split heuristically from the `name`/`description` field (looking for a
   trailing `(v1.0)`-style pattern); anything that doesn't match falls back to version `"1.0"` —
   use the rename feature above to clean up individual entries afterward if needed.
3. You get a preview (name, version, SHA-1, and a per-row validity check) before anything is
   sent, so you can sanity-check before committing.
4. The server (`/api/admin/import`) re-validates every row, skips anything whose SHA-1 already
   exists in the database, and creates the rest as `Submission` + `ApprovedEntry` pairs in small
   transactional batches — partial failures (e.g. a name collision) are collected and reported
   per-row rather than aborting the whole import.
5. Imported entries do **not** generate trust events for the importing admin — that's reserved
   for actual community contributions, not bulk-seeding.

---

## Sessions are database-backed, not JWT

This matters enough to call out explicitly: `session: { strategy: 'database' }` in
`src/lib/auth.ts`. Every request reads the live `Session` + `User` rows from Postgres — role,
trust score, and ban status are never cached in the cookie itself, only an opaque session token
is. This was a deliberate switch away from the default JWT strategy, which embeds those fields
into the cookie at sign-in time; with JWT, any admin action that changes *someone else's* role,
trust, or ban status had no way to reach a session that was already issued, so the affected user
wouldn't see the change until they happened to get a fresh token (sign out/in, or token
rotation). With database sessions this class of bug isn't possible — there's nothing to go stale.

This is also what makes ban enforcement actually work: banning someone now deletes their active
`Session` rows outright (immediate forced logout, not just "blocked on next login"), and every
write-route checks `session.user.isBanned` fresh on every request.

## Import history, logs, and reversal

Every `/admin/import` run creates a `DatImport` row tracking filename, file size, platform,
counts (imported/skipped-duplicate/error), and a JSON log of everything that *didn't* make it in
with a reason why. The history section on that page shows the last 20 imports with:

- **Log download** (`/api/admin/import/[id]/log`) — a CSV listing every imported entry plus every
  skipped/failed one with its reason, regenerated on demand rather than stored as a file.
- **Reverse** — rejects every submission from that batch and removes their `ApprovedEntry` rows
  (so they drop out of the exported DAT), consistent with the rest of the app's "never hard-delete
  history" approach: the submissions themselves stay in the database with status `REJECTED` and a
  full audit trail, not deleted. A reversed import is marked as such and can't be reversed twice.

Batches sent to the same import are linked by an `importId` the client tracks across upload
chunks — the first chunk creates the `DatImport` row, every subsequent chunk appends to it,
so one big DAT file still produces exactly one history entry.

## Change requests

Any signed-in, non-banned user can propose a change to an existing submission's metadata (name,
version, author, year, platform, source URL) without needing edit access themselves — useful for
catching mistakes in someone else's submission, or in a bulk-imported legacy entry. The request
only stores the fields that actually differ from the current values. An admin reviews it from
either the submission page itself or the dedicated `/admin/change-requests` queue; approving
applies the change atomically and — same as the rename feature — syncs the live `ApprovedEntry`
if the submission is already `APPROVED` and a rename-relevant field changed.

---

## Design philosophy

No cryptographic proof of honesty is attempted. The submitter makes a claim, independent
verifiers reproduce the hash from their own copy, and weighted consensus plus human admin
judgment decides what enters the master DAT. This mirrors how No-Intro and Redump actually work
in practice — trusted humans with dumping rigs, not algorithms, are the root of trust.
