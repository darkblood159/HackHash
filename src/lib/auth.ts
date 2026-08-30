// src/lib/auth.ts
import { NextAuthOptions } from 'next-auth';
import GithubProvider from 'next-auth/providers/github';
import DiscordProvider from 'next-auth/providers/discord';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from './prisma';
import { UserRole } from '@prisma/client';

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma) as NextAuthOptions['adapter'],
  // NOTE on LAN/IP access: next-auth v4 does NOT have a `trustHost` config
  // option (that's a v5/Auth.js thing). In v4, origin detection is controlled
  // entirely by the AUTH_TRUST_HOST environment variable — see
  // node_modules/next-auth/utils/detect-origin.js. Set AUTH_TRUST_HOST=true
  // in .env if you need sign-in to work from a host other than NEXTAUTH_URL
  // (e.g. a LAN IP). See .env.example for details.
  providers: [
    GithubProvider({
      clientId: process.env.GITHUB_ID!,
      clientSecret: process.env.GITHUB_SECRET!,
      // AUG-26: lets a GitHub sign-in attach to an existing account that
      // already has the same email, instead of always creating a second,
      // separate account — see the account-linking design note on the
      // signIn callback below for the full picture. Safe specifically on
      // GitHub because GitHub enforces account-wide email verification —
      // by the time an email appears in the /user response this provider's
      // profile() reads below, it's expected to already be a verified one.
      // GitHub's API doesn't expose a separate "verified" flag on this
      // endpoint the way Discord does, so this rests on GitHub's own
      // platform behavior rather than something checked here — this is the
      // standard, widely-used assumption for GitHub OAuth, not a novel one.
      allowDangerousEmailAccountLinking: true,
      profile(profile) {
        return {
          id: profile.id.toString(),
          name: profile.name ?? profile.login,
          email: profile.email,
          image: profile.avatar_url,
          username: profile.login,
          role: UserRole.GUEST,
          trustScore: 0,
        };
      },
    }),
    ...(process.env.DISCORD_CLIENT_ID
      ? [
          DiscordProvider({
            clientId: process.env.DISCORD_CLIENT_ID!,
            clientSecret: process.env.DISCORD_CLIENT_SECRET!,
            // Same reasoning as GitHub above, EXCEPT Discord's own API
            // explicitly exposes a `verified: boolean` on the user object
            // whenever the `email` scope is granted (which this provider
            // requests by default, and which this project's profile()
            // below already relies on for `profile.email`) — so, unlike
            // GitHub, this can and does get checked, in the signIn
            // callback below, BEFORE this flag is ever allowed to actually
            // merge a Discord sign-in into an existing account. Without
            // that check, this flag alone would be a real account-takeover
            // hole: anyone could sign in with Discord claiming an email
            // they haven't actually confirmed, and get merged straight
            // into whichever existing HackHash account already used that
            // email via GitHub.
            allowDangerousEmailAccountLinking: true,
            profile(profile) {
              const avatarUrl = profile.avatar
                ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
                : `https://cdn.discordapp.com/embed/avatars/${parseInt(profile.discriminator) % 5}.png`;
              return {
                id: profile.id,
                name: profile.global_name ?? profile.username,
                email: profile.email,
                image: avatarUrl,
                username: profile.username,
                role: UserRole.GUEST,
                trustScore: 0,
              };
            },
          }),
        ]
      : []),
  ],
  callbacks: {
    // AUG-26: gates the Discord side of allowDangerousEmailAccountLinking
    // (set on both providers above). Confirmed directly from
    // next-auth@4.24.7's own source that this callback runs BEFORE the
    // adapter's own getUserByEmail/linkAccount logic for every sign-in
    // (core/routes/callback.js calls callbacks.signIn first; the actual
    // linking happens after, in core/lib/callback-handler.js) — so
    // returning a redirect here fully prevents an unverified Discord email
    // from ever reaching the point where it could get merged into an
    // existing account. Deliberately applies the same way whether someone
    // is signing in fresh or manually connecting Discord from an
    // already-logged-in session (see the /account page) — those two cases
    // aren't cleanly distinguishable from what this callback receives, and
    // requiring a verified email either way is a reasonable, explainable
    // rule rather than a gap worth the complexity of telling them apart.
    async signIn({ account, profile }) {
      if (account?.provider === 'discord') {
        const discordProfile = profile as { email?: string | null; verified?: boolean } | undefined;
        if (discordProfile?.email && discordProfile.verified !== true) {
          return '/auth/error?error=discord_email_unverified';
        }
      }
      return true;
    },
    async session({ session, user }) {
      // With database sessions (below), `user` here is the live row read
      // fresh from the DB on every single request — not a cached JWT claim.
      // This is the fix for role/trust/ban changes only taking effect after
      // a fresh sign-in: with the previous JWT strategy, role/trustScore were
      // baked into the session cookie at sign-in time and only updated via an
      // explicit client-side update() call, which nothing was calling for
      // admin-initiated changes (banning someone, promoting them, adjusting
      // their trust score) since those happen in a DIFFERENT browser/session
      // than the affected user's.
      const dbUser = user as typeof user & { role: UserRole; trustScore: number; username: string | null; isBanned: boolean };
      if (session.user) {
        session.user.id = dbUser.id;
        session.user.role = dbUser.role;
        session.user.trustScore = dbUser.trustScore;
        session.user.username = dbUser.username ?? undefined;
        session.user.isBanned = dbUser.isBanned;
      }
      return session;
    },
  },

  events: {
    async createUser({ user }) {
      // AUG-26: next-auth fires this event — and internally hardcodes
      // isNewUser: true — even when `user` is an EXISTING user matched via
      // allowDangerousEmailAccountLinking, not just for genuine first-time
      // creation. Confirmed directly from next-auth@4.24.7's source
      // (core/lib/callback-handler.js): in that code path it calls
      // events.createUser unconditionally right after resolving `user`
      // (whether newly created or matched by email), and always BEFORE
      // linkAccount() runs for either case. That ordering is the reliable
      // way to tell the two apart here: a genuinely brand-new user has
      // zero Account rows at this exact moment; an existing user gaining
      // an additional linked provider already has at least one, from
      // whenever they first signed up. (user.createdAt can't tell you WHY
      // this event fired, and next-auth's own isNewUser flag is hardcoded
      // true for both cases in this branch, so neither is usable here.)
      const priorAccountCount = await prisma.account.count({ where: { userId: user.id } });
      if (priorAccountCount > 0) {
        // Existing user, matched by email during a second provider's
        // sign-in — audit-logged from the linkAccount event below
        // instead, which is what actually happened. Do NOT re-run the
        // admin auto-promote check here either: that's meant to apply
        // once, at genuine first creation — re-running it on every
        // subsequent linked provider could incorrectly re-promote someone
        // who'd been deliberately demoted after their account was first
        // created.
        return;
      }

      // Auto-promote the initial admin
      const adminEmail = process.env.INITIAL_ADMIN_EMAIL;
      if (adminEmail && user.email === adminEmail) {
        await prisma.user.update({
          where: { id: user.id },
          data: { role: UserRole.ADMINISTRATOR },
        });
      }

      // Log the account creation
      await prisma.auditLog.create({
        data: {
          action: 'USER_CREATED',
          details: { userId: user.id, email: user.email },
          userId: user.id,
        },
      });
    },

    async linkAccount({ user, account }) {
      // Fires for EVERY successful account link, including a brand-new
      // user's very first provider (alongside the createUser event above,
      // in that exact case) — so this only logs its own audit entry once
      // it's genuinely an ADDITIONAL provider, not the first one. The
      // adapter's linkAccount() has already run by the time this event
      // fires (same source read as above), so counting Account rows HERE
      // — not inside createUser, where the count would still be pre-link
      // — is the correct moment to check: exactly 1 means this was that
      // first-ever link (already covered by createUser's own log line);
      // more than 1 means an existing account just gained another one,
      // either from someone manually connecting a second provider from
      // the /account page while already logged in, or from the
      // verified-email auto-link path (both providers' profile()
      // callbacks + allowDangerousEmailAccountLinking, gated by the
      // signIn callback above for Discord specifically).
      const accountCount = await prisma.account.count({ where: { userId: user.id } });
      if (accountCount > 1) {
        await prisma.auditLog.create({
          data: {
            action: 'ACCOUNT_LINKED',
            details: { userId: user.id, email: user.email, provider: account.provider },
            userId: user.id,
          },
        });
      }
    },
  },

  // Database sessions: the cookie only holds an opaque session token, and
  // every request reads the actual Session + User rows fresh from Postgres.
  // This costs one extra DB read per request versus JWT, which is the right
  // tradeoff here — role/trust/ban are exactly the kind of thing that needs
  // to be authoritative, not cached.
  session: { strategy: 'database' },
  pages: {
    signIn: '/auth/signin',
    error: '/auth/error',
  },
};
