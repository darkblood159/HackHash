'use client';

// src/app/auth/error/page.tsx
import React, { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';

// AUG-26: this used to show the exact same generic "something went wrong"
// message for every failure, never reading the ?error= code next-auth
// actually attaches to the redirect. That made it impossible to tell, from
// the UI alone, WHY a sign-in failed — including the specific, actionable
// cases below, where the fix is something the person hitting this page can
// actually do something about.
const ERROR_MESSAGES: Record<string, { title: string; body: string }> = {
  OAuthAccountNotLinked: {
    title: 'That email is already in use',
    body: 'An account already exists with this email address, signed up through a different method. Sign in with whichever method you used originally, then connect this one from your account settings afterward.',
  },
  discord_email_unverified: {
    title: 'Discord email not verified',
    body: "Discord hasn't confirmed this email address yet. Verify it with Discord first (check your email for their confirmation link), then try signing in again.",
  },
  Configuration: {
    title: "This sign-in method isn't set up correctly",
    body: 'There\u2019s a server-side configuration problem with this sign-in method. If you\u2019re the admin: double check the client ID/secret and the redirect URI registered with the provider match exactly.',
  },
  AccessDenied: {
    title: 'Sign-in was denied',
    body: 'This sign-in attempt was blocked. If you didn\u2019t expect this, try again or use a different sign-in method.',
  },
  OAuthSignin: {
    title: "Couldn't start sign-in",
    body: 'Something went wrong before reaching the provider. Please try again.',
  },
  OAuthCallback: {
    title: 'Sign-in was interrupted',
    body: 'Something went wrong on the way back from the provider. Please try again.',
  },
  Verification: {
    title: 'That link has expired',
    body: 'This sign-in link is no longer valid. Please request a new one.',
  },
};

const DEFAULT_ERROR = {
  title: 'Sign-in failed',
  body: 'Something went wrong while signing you in. Please try again.',
};

function ErrorContent() {
  const searchParams = useSearchParams();
  const errorCode = searchParams.get('error');
  const { title, body } = (errorCode && ERROR_MESSAGES[errorCode]) || DEFAULT_ERROR;

  return (
    <>
      <h1 className="font-display text-xl font-bold mb-2">{title}</h1>
      <p className="text-text-secondary text-sm mb-6">{body}</p>
    </>
  );
}

export default function AuthErrorPage() {
  return (
    <div className="max-w-sm mx-auto px-4 py-24 text-center">
      <AlertTriangle size={32} className="text-status-rejected mx-auto mb-4" />
      {/* useSearchParams() requires a Suspense boundary in the App Router,
          or `next build` fails static generation for this page — the
          fallback below is what a static pass would render before the
          client resolves the real error code. */}
      <Suspense
        fallback={
          <>
            <h1 className="font-display text-xl font-bold mb-2">Sign-in failed</h1>
            <p className="text-text-secondary text-sm mb-6">Something went wrong while signing you in. Please try again.</p>
          </>
        }
      >
        <ErrorContent />
      </Suspense>
      <Link href="/auth/signin" className="text-phosphor text-sm hover:underline">
        Back to sign in
      </Link>
    </div>
  );
}
