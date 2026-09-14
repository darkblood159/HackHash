# Deploying HackHash to Portainer

This walks through deploying HackHash as a Portainer stack, with a fresh,
self-contained Postgres database (separate from any existing database you
might already be running elsewhere on the same machine).

Heads up before you start: the Dockerfile in this project hasn't been
test-built in every possible environment. Step 4 below is where you'll find
out if anything needs adjusting for yours. If `docker build` throws an
error, that's the first thing to fix before moving on.

---

## What you'll end up with

Two containers in one stack:
- **db** — a Postgres 18 container, data stored in a Docker volume so it
  survives restarts/updates
- **app** — the HackHash web app itself, listening on port 3000

The app container automatically runs database migrations every time it
starts (this is already built into `docker-entrypoint.sh`), so you'll never
need to run `prisma migrate deploy` by hand in this setup.

---

## Before you start: decide how you'll access the site

You need to know the URL people will actually type to reach HackHash
*before* creating the OAuth apps below, because the callback URLs have to
match it exactly. Pick one:

- LAN only, no domain: `http://<your-server-LAN-IP>:3000`
- Behind a reverse proxy with a domain (Nginx Proxy Manager, Caddy, etc.):
  `https://yourdomain.com`

Everywhere below that says `YOUR_URL`, substitute whichever of these applies
to you. (If you already run a reverse proxy like Nginx Proxy Manager or
Caddy, you'd point a proxy host at `<your-server-hostname-or-LAN-IP>:3000`
and use your domain here instead of the raw IP.)

---

## Step 1 — Create a GitHub OAuth App (required)

GitHub sign-in is mandatory in this app — there's no way to sign in without
it currently.

1. Go to https://github.com/settings/developers → **New OAuth App**
2. **Homepage URL:** `YOUR_URL`
3. **Authorization callback URL:** `YOUR_URL/api/auth/callback/github`
4. Create it, then generate a **Client Secret**
5. Save the **Client ID** and **Client Secret** — you'll need both shortly

## Step 2 — Create a Discord OAuth App (optional)

Skip this if you don't want Discord sign-in.

1. Go to https://discord.com/developers/applications → **New Application**
2. Under **OAuth2**, add a redirect URL of EXACTLY `YOUR_URL/api/auth/callback/discord` —
   this has to match your `NEXTAUTH_URL` character-for-character (same
   `http`/`https`, same domain, no trailing slash difference). This is the
   single most common thing to get slightly wrong here: if it doesn't match,
   Discord itself will refuse the sign-in with its own "Invalid OAuth2
   redirect_uri" error, before ever handing control back to this site at all.
3. Save the **Client ID** and **Client Secret**

Once this is set up (both the redirect URL above and the `DISCORD_CLIENT_ID`/
`DISCORD_CLIENT_SECRET` env vars in Step 5 below), anyone who signs in with
GitHub and Discord using the same, Discord-verified email address is
automatically recognized as the same person and lands on one account either
way — no separate action needed. If someone's Discord and GitHub emails
don't match, or their Discord email isn't verified yet, they'll each need to
sign in with the method they used originally and connect the other one from
**Account settings** while already logged in.

## Step 3 — Generate a NextAuth secret

Run this on your server and save the output:

```bash
openssl rand -base64 32
```

## Step 4 — Build the Docker image locally

Portainer's stack editor can't build from a Dockerfile directly (it only
receives the YAML text, not your actual source code) — so we build the
image ourselves first, then just tell the stack to use it.

```bash
cd ~/DockerStuff/Hash_Website
docker build -t hackhash:latest .
```

This will take a few minutes the first time. **If this errors out, send me
the exact output** — this is the untested part mentioned above, and I'll
fix whatever it hits.

## Step 5 — Add the stack in Portainer

1. In Portainer: **Stacks → Add stack**
2. Name it something like `hackhash`
3. Choose **Web editor**
4. Paste in the contents of `portainer-stack.yml` (included in this project)
5. Scroll to **Environment variables** and add these:

| Variable | Value |
|---|---|
| `POSTGRES_PASSWORD` | any strong password you choose |
| `NEXTAUTH_URL` | `YOUR_URL` from above |
| `NEXTAUTH_SECRET` | the value from Step 3 |
| `GITHUB_ID` | from Step 1 |
| `GITHUB_SECRET` | from Step 1 |
| `DISCORD_CLIENT_ID` | from Step 2 (leave blank if skipped) |
| `DISCORD_CLIENT_SECRET` | from Step 2 (leave blank if skipped) |
| `INITIAL_ADMIN_EMAIL` | **the email on the GitHub/Discord account you'll sign in with first** — see Step 7 |
| `HASHEOUS_API_KEY` | only if you're using the Hasheous integration — your Hasheous API key (X-API-Key) |
| `HASHEOUS_ENV` | only if you're using the Hasheous integration — `production` for the real hasheous.org, `beta` for beta.hasheous.org. **This one is easy to miss and fails silently if you do** — if it's left out, the app defaults to `beta` with no error at all, which means every pull and push quietly talks to a different Hasheous database than the one you're actually looking at. If Hasheous corrections don't seem to "stick," this is the first thing to check. |
| `UPSTASH_REDIS_REST_URL` | optional, but recommended before going public — REST URL from an Upstash Redis database (free tier at upstash.com). Protects submissions, verification, and search from spam/scraping. **Also fails silently if left out** — same shape of issue as `HASHEOUS_ENV` above: leaving it blank doesn't error, it just leaves those three endpoints completely unlimited. |
| `UPSTASH_REDIS_REST_TOKEN` | the REST token from the same Upstash database as above — both are required together for rate limiting to actually turn on. |

Added a repo `.env` file for your own local reference doesn't count here —
Docker never sees it (`.dockerignore` excludes it from the image on
purpose, so secrets in it can't accidentally end up baked into a built
image). Anything the running app needs has to be entered directly into
Portainer's own **Environment variables** section above, every time you
set up or update the stack.

6. Click **Deploy the stack**

## Step 6 — Check it came up

**Containers** in Portainer → you should see `hackhash-db-1` and
`hackhash-app-1` (or similar names) both running. Click the `app`
container's **Logs** — you should see:

```
Applying database migrations...
Starting server...
```

If it instead shows an error here, that's most likely a database connection
issue (wrong password, or the db container isn't healthy yet) — send me the
log output.

Visit `YOUR_URL` — you should see the HackHash homepage with a fresh, empty
database.

## Step 7 — Sign in and become admin

Sign in with the GitHub (or Discord) account whose **email matches
`INITIAL_ADMIN_EMAIL`** exactly. The very first time that account signs in,
it's automatically promoted to Administrator. This only happens once, on
first sign-up — if you sign in with a different account first by mistake,
you'll need to promote yourself manually via the database afterward, so it's
worth double-checking the email matches before this step.

## Step 8 — Seed starter data (one-time)

Migrations run automatically, but the starter data (default tags like
"Translation"/"Bug Fix", and site settings) doesn't. Run it once:

- In Portainer: click the `app` container → **Console** → **Connect** (as
  user, default command) → run:
  ```bash
  npm run db:seed
  ```
- Or from your own terminal:
  ```bash
  docker exec -it hackhash-app-1 npm run db:seed
  ```
  (adjust the container name if Portainer named it differently)

You should see `🌱 Seeding database...` then `✅ Seed complete`.

One thing worth changing afterward: the seed data includes placeholder
`dat_name`/`dat_description`/`dat_url`/`dat_author` site settings (used in
the generated DAT files) — there's no admin settings page for these yet, so
for now the way to change them is directly in the database, e.g.:

```sql
UPDATE "SiteSetting" SET value = 'https://your-real-domain.example' WHERE key = 'dat_url';
```

(same idea for `dat_name`, `dat_description`, `dat_author`). If a setting
is missing entirely rather than just wrong, re-running `npm run db:seed` is
safe — it only fills in whatever's missing, it won't overwrite anything
you've already changed.

---

## Updating the app later

Since Portainer is using a locally-built image (not one it built itself),
updating means rebuilding that image yourself, then telling Portainer to
pick up the new version:

```bash
cd ~/DockerStuff/Hash_Website
# pull/apply whatever code changes first, then:
docker build -t hackhash:latest .
```

Then in Portainer: **Containers → app container → Recreate** (leave "pull
latest image" **unchecked** — there's no registry involved, it's a local
tag). Migrations for any new schema changes will run automatically on
startup, same as always.

If you want this to be less manual longer-term, Portainer also supports
deploying stacks directly from a Git repository (it clones the repo and
builds from within it, which sidesteps today's build-context limitation
entirely) — worth considering if you start pushing this project to a GitHub
or self-hosted git server. Happy to write that version of the guide if/when
you get there.

## If a migration fails on startup (P3009)

Every time the `app` container starts — including every time you Recreate
it after an update — `docker-entrypoint.sh` runs `npx prisma migrate
deploy` before starting the server. If that gets interrupted partway
through (the container is killed/restarted, or loses its connection to the
database, mid-migration), Prisma marks that migration as "started but
never confirmed finished" and refuses to run anything else — including
migrations that had nothing to do with the interruption — until it's told
what actually happened.

Because the `app` service restarts automatically (`restart: always`), this
usually shows up as the container endlessly restarting, with logs ending
in something like:

```
Error: P3009 migrate found failed migrations in the target database, new migrations will not be applied.
The `<migration_name>` migration started at ... failed
```

This does not mean anything got corrupted — it's Prisma's own bookkeeping
being unsure, not the database. Every migration in this project is written
to be safe to re-run. To fix it:

1. **Check what the migration was actually trying to do.** Open
   `prisma/migrations/<migration_name>/migration.sql` in the project — it's
   plain SQL, readable without any special tooling.
2. **Check whether it actually happened.** Connect to the `db` container
   and check for whatever the migration was creating, e.g.:
   ```bash
   docker exec -it hackhash-db-1 psql -U postgres -d romhackdat -c '\d "TableNameFromTheMigration"'
   ```
   (swap in the real table/column name from the migration file). If it
   describes something real, the migration's SQL DID run — Prisma just
   never got to record that. If it says the relation doesn't exist, it did
   NOT run.
3. **Tell Prisma which one is true, then let it continue:**
   ```bash
   # If step 2 showed it DID happen:
   docker exec -it hackhash-app-1 npx prisma migrate resolve --applied "<migration_name>"

   # If step 2 showed it did NOT happen:
   docker exec -it hackhash-app-1 npx prisma migrate resolve --rolled-back "<migration_name>"
   ```
   Then Recreate (or just restart) the `app` container so `migrate deploy`
   runs again — resolved as `--rolled-back`, it'll actually run that
   migration's SQL for real this time; resolved as `--applied`, it'll skip
   straight to whatever comes after it.

**Important:** `--applied` only tells Prisma "trust me, this already
happened" — it does not run the SQL itself. If it's used on a migration
that actually never ran, the database will be permanently missing whatever
that migration was supposed to add, and the app will error the moment it
touches that table/column. When you're not sure which one is true, do the
`psql` check in step 2 rather than guessing — or just resolve as
`--rolled-back` and let Prisma run it for real.

If this happens with more than one migration queued up at once, only the
FIRST one gets named in the error — resolve it, then re-run `migrate
deploy` (Recreate the container again) to find out whether the next one in
line also needs resolving, rather than assuming a single resolve fixed
everything.
