// src/app/account/page.tsx
import React from 'react';
import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { ConnectedAccounts } from '@/components/ConnectedAccounts';

export default async function AccountPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    // AUG-27: paired with the same-day fix to /auth/signin — that page now
    // reads this exact query param and passes it through to signIn() as the
    // post-sign-in destination, instead of defaulting to wherever it
    // happens to be clicked from (which, for this specific redirect, would
    // otherwise have been the sign-in page itself).
    redirect('/auth/signin?callbackUrl=/account');
  }

  const accounts = await prisma.account.findMany({
    where: { userId: session.user.id },
    select: { provider: true },
  });
  const linkedProviders = accounts.map((a) => a.provider);

  return (
    <div className="max-w-md mx-auto px-4 py-16">
      <h1 className="font-display text-2xl font-bold mb-1">Account settings</h1>
      <p className="text-text-secondary text-sm mb-8">
        Manage the sign-in methods connected to your account.
      </p>

      <ConnectedAccounts
        linkedProviders={linkedProviders}
        discordConfigured={!!process.env.DISCORD_CLIENT_ID}
      />
    </div>
  );
}
