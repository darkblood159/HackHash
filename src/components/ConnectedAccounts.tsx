'use client';

// src/components/ConnectedAccounts.tsx
// AUG-26: lets an already-signed-in user attach a second provider to their
// existing account. This deliberately does NOT need any custom linking
// logic on the backend — calling signIn() while a session is already active
// is enough on its own. next-auth's own adapter flow detects the active
// session and calls its adapter's linkAccount() to attach the new provider
// to the CURRENTLY LOGGED IN user, rather than looking anything up by email
// — confirmed directly from next-auth@4.24.7's source
// (core/lib/callback-handler.js, the `if (user) { await linkAccount(...) }`
// branch). This component is just the visible surface for that.
import React, { useState } from 'react';
import { signIn } from 'next-auth/react';
import { Github, MessageCircle, Check, Link2, Unlink } from 'lucide-react';

interface ConnectedAccountsProps {
  linkedProviders: string[];
  discordConfigured: boolean;
}

const PROVIDER_META: Record<string, { label: string; icon: React.ReactNode }> = {
  github: { label: 'GitHub', icon: <Github size={18} /> },
  discord: { label: 'Discord', icon: <MessageCircle size={18} /> },
};

export function ConnectedAccounts({ linkedProviders, discordConfigured }: ConnectedAccountsProps) {
  const [linked, setLinked] = useState(linkedProviders);
  const [pendingUnlink, setPendingUnlink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const availableProviders = ['github', ...(discordConfigured ? ['discord'] : [])];

  async function handleUnlink(provider: string) {
    if (linked.length <= 1) return; // guarded server-side too; UI shouldn't even allow reaching this
    if (!confirm(`Disconnect ${PROVIDER_META[provider]?.label ?? provider}? You'll no longer be able to sign in with it.`)) {
      return;
    }
    setPendingUnlink(provider);
    setError(null);
    try {
      const res = await fetch('/api/account/unlink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Failed to disconnect');
      }
      setLinked((prev) => prev.filter((p) => p !== provider));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect');
    } finally {
      setPendingUnlink(null);
    }
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="text-sm text-status-rejected bg-status-rejected-bg border border-status-rejected/30 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      {availableProviders.map((provider) => {
        const isLinked = linked.includes(provider);
        const meta = PROVIDER_META[provider];
        const isOnlyOne = isLinked && linked.length <= 1;

        return (
          <div
            key={provider}
            className="flex items-center justify-between px-4 py-3 rounded-md bg-bg-elevated border border-border"
          >
            <div className="flex items-center gap-3">
              {meta.icon}
              <div>
                <div className="text-sm font-medium text-text-primary">{meta.label}</div>
                {isLinked && (
                  <div className="text-xs text-status-approved flex items-center gap-1">
                    <Check size={11} /> Connected
                  </div>
                )}
              </div>
            </div>

            {isLinked ? (
              <button
                onClick={() => handleUnlink(provider)}
                disabled={isOnlyOne || pendingUnlink === provider}
                title={isOnlyOne ? "Can't disconnect your only sign-in method" : undefined}
                className="flex items-center gap-1.5 text-xs font-medium text-text-muted hover:text-status-rejected disabled:opacity-40 disabled:cursor-not-allowed transition-colors px-2 py-1"
              >
                <Unlink size={13} />
                {pendingUnlink === provider ? 'Disconnecting…' : 'Disconnect'}
              </button>
            ) : (
              <button
                onClick={() => signIn(provider, { callbackUrl: '/account' })}
                className="flex items-center gap-1.5 text-xs font-medium text-phosphor hover:underline px-2 py-1"
              >
                <Link2 size={13} /> Connect
              </button>
            )}
          </div>
        );
      })}

      <p className="text-xs text-text-muted pt-2">
        Connecting a second method lets you sign in with either one — they&apos;ll always lead back to this same account.
      </p>
    </div>
  );
}
