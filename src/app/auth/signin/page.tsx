'use client';

// src/app/auth/signin/page.tsx
import React, { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { signIn, getProviders, type ClientSafeProvider } from 'next-auth/react';
import { Github, MessageCircle, Disc3 } from 'lucide-react';

// AUG-26: this used to render both buttons unconditionally, regardless of
// whether Discord was actually configured server-side (authOptions only
// registers the Discord provider at all when DISCORD_CLIENT_ID is set — see
// src/lib/auth.ts). That meant a misconfigured/not-yet-set-up Discord still
// showed a working-looking button that would just fail when clicked, with no
// indication why. Now fetches the real, currently-active provider list from
// next-auth itself (the same list authOptions.providers actually resolves
// to) and only renders a button for a provider that's genuinely there.
const PROVIDER_ICON: Record<string, React.ReactNode> = {
  github: <Github size={16} />,
  discord: <MessageCircle size={16} />,
};

function SignInButtons() {
  const [providers, setProviders] = useState<ClientSafeProvider[] | null>(null);
  const searchParams = useSearchParams();

  // AUG-27 FIX: next-auth's signIn() defaults callbackUrl to
  // window.location.href — the CURRENT page — whenever it isn't given one
  // explicitly (confirmed directly from next-auth@4.24.7's own source,
  // react/index.js). This page never set one, so the moment anything routes
  // here first (as of Aug 26, the navbar's own "Sign in" button does exactly
  // that) rather than calling signIn() directly from wherever the user
  // started, the "current page" it defaults to IS this sign-in page —
  // meaning a fully successful sign-in redirected right back here instead of
  // anywhere useful. Two parts to the fix: read ?callbackUrl= if one is
  // already present (next-auth itself appends this automatically when it
  // redirects an unauthenticated visitor here from a protected page, and
  // src/app/account/page.tsx's own redirect() does the same on purpose —
  // see below), otherwise fall back to the site's home page, NEVER to
  // window.location.href / "wherever this button happens to be clicked
  // from" the way next-auth's own default silently does.
  const callbackUrl = searchParams.get('callbackUrl') || '/';

  useEffect(() => {
    getProviders().then((result) => {
      setProviders(result ? Object.values(result) : []);
    });
  }, []);

  if (providers === null) {
    // Brief loading state while the real provider list resolves —
    // deliberately not showing any button yet rather than guessing, since a
    // stale/optimistic render here is exactly the kind of "looks like it
    // should work" trap this fetch is meant to avoid.
    return <div className="h-11 rounded-md bg-bg-elevated border border-border animate-pulse" />;
  }

  return (
    <>
      {providers.map((provider) => (
        <button
          key={provider.id}
          onClick={() => signIn(provider.id, { callbackUrl })}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-bg-elevated border border-border text-text-primary text-sm font-medium hover:border-phosphor/40 transition-colors"
        >
          {PROVIDER_ICON[provider.id]} Continue with {provider.name}
        </button>
      ))}
    </>
  );
}

export default function SignInPage() {
  return (
    <div className="max-w-sm mx-auto px-4 py-24 text-center">
      <div className="w-12 h-12 rounded-xl bg-phosphor/10 border border-phosphor/30 flex items-center justify-center mx-auto mb-6">
        <Disc3 size={22} className="text-phosphor" />
      </div>
      <h1 className="font-display text-2xl font-bold mb-2">Sign in</h1>
      <p className="text-text-secondary text-sm mb-8">
        Sign in to submit ROM hacks, verify community submissions, and build your trust score.
      </p>

      <div className="space-y-3">
        {/* useSearchParams() requires a Suspense boundary in the App
            Router, or `next build` fails static generation for this page —
            same fix already applied to /auth/error for the same reason. */}
        <Suspense fallback={<div className="h-11 rounded-md bg-bg-elevated border border-border animate-pulse" />}>
          <SignInButtons />
        </Suspense>
      </div>

      <p className="text-xs text-text-muted mt-8">
        New accounts start at 0 trust. Trust is earned through approved submissions and accurate verifications.
      </p>
    </div>
  );
}
