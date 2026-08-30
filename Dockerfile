# Dockerfile
#
# This was written without the ability to test-build it (no Docker daemon in
# the environment that produced it). It deliberately favors reliability over
# image size: it copies the full node_modules into the runtime image instead
# of using Next.js's "standalone" output trace, specifically so the `prisma`
# CLI is available at container startup to run migrations — Prisma's engine
# binaries are a common source of "works on my machine, breaks in the
# container" issues with the trimmed standalone approach, and that's not a
# risk worth taking in a setup nobody has run yet. Optimize later once it's
# confirmed working.

FROM node:20-alpine AS base
RUN apk add --no-cache openssl libc6-compat

# ─── Dependencies ───────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# The schema needs to be present before `npm ci` runs, since `npm ci`
# triggers the postinstall script (`prisma generate`), which fails if
# prisma/schema.prisma isn't there yet. Copied separately from the rest of
# the source (which still comes in later, in the builder stage) so this
# layer only invalidates when package.json/package-lock.json or the schema
# itself change — not on every source-code edit.
COPY prisma ./prisma
RUN npm ci

# ─── Build ──────────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

# ─── Runtime ────────────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.js ./next.config.js
COPY docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x docker-entrypoint.sh && chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000
ENV PORT=3000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["npm", "start"]
