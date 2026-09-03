'use client';

// src/components/UserActionMenu.tsx
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MoreVertical } from 'lucide-react';
import { TRUST_TIER_THRESHOLDS } from '@/types';

const ROLES = ['GUEST', 'CONTRIBUTOR', 'VERIFIER', 'ADMINISTRATOR'];
const TRUSTED_THRESHOLD = TRUST_TIER_THRESHOLDS.TRUSTED;
const VETERAN_THRESHOLD = TRUST_TIER_THRESHOLDS.VETERAN;

export function UserActionMenu({
  userId,
  currentRole,
  trustScore,
  isBanned,
  commentCount = 0,
}: {
  userId: string;
  currentRole: string;
  trustScore: number;
  isBanned: boolean;
  commentCount?: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [customAmount, setCustomAmount] = useState('');
  const [confirmingDeleteComments, setConfirmingDeleteComments] = useState(false);

  const act = async (body: Record<string, unknown>) => {
    setLoading(true);
    try {
      await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, ...body }),
      });
      router.refresh();
      setOpen(false);
      setCustomAmount('');
      setConfirmingDeleteComments(false);
    } finally {
      setLoading(false);
    }
  };

  const promoteToTier = (target: number, label: string) => {
    const delta = target - trustScore;
    if (delta <= 0) return;
    act({ action: 'ADJUST_TRUST', trustDelta: delta, reason: `Promoted to ${label} tier by admin` });
  };

  const applyCustomAmount = () => {
    const amount = Number(customAmount);
    if (!Number.isFinite(amount) || amount === 0) return;
    act({ action: 'ADJUST_TRUST', trustDelta: amount, reason: 'Manual admin adjustment' });
  };

  return (
    <div className="relative inline-block text-left">
      <button onClick={() => setOpen((v) => !v)} className="p-1.5 rounded-md hover:bg-bg-elevated text-text-muted">
        <MoreVertical size={14} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1 w-60 rounded-lg border border-border bg-bg-elevated shadow-card-hover py-1">
            <div className="px-3 py-1.5 text-[10px] text-text-muted uppercase tracking-wider">Set role</div>
            {ROLES.map((role) => (
              <button
                key={role}
                disabled={loading || role === currentRole}
                onClick={() => act({ action: 'SET_ROLE', role })}
                className="w-full text-left px-3 py-1.5 text-sm text-text-primary hover:bg-bg-hover disabled:opacity-40"
              >
                {role.charAt(0) + role.slice(1).toLowerCase()}
              </button>
            ))}

            <div className="border-t border-border-subtle my-1" />
            <div className="px-3 py-1.5 text-[10px] text-text-muted uppercase tracking-wider">Trust tier</div>
            <button
              disabled={loading || trustScore >= TRUSTED_THRESHOLD}
              onClick={() => promoteToTier(TRUSTED_THRESHOLD, 'trusted')}
              className="w-full text-left px-3 py-1.5 text-sm text-status-verified hover:bg-bg-hover disabled:opacity-40"
            >
              {trustScore >= TRUSTED_THRESHOLD ? 'Already Trusted+' : `Promote to Trusted (${TRUSTED_THRESHOLD})`}
            </button>
            <button
              disabled={loading || trustScore >= VETERAN_THRESHOLD}
              onClick={() => promoteToTier(VETERAN_THRESHOLD, 'veteran')}
              className="w-full text-left px-3 py-1.5 text-sm text-phosphor hover:bg-bg-hover disabled:opacity-40"
            >
              {trustScore >= VETERAN_THRESHOLD ? 'Already Veteran' : `Promote to Veteran (${VETERAN_THRESHOLD})`}
            </button>

            <div className="border-t border-border-subtle my-1" />
            <div className="px-3 py-1.5 text-[10px] text-text-muted uppercase tracking-wider">Quick adjust</div>
            <div className="flex gap-1.5 px-3 pb-1.5">
              <button
                disabled={loading}
                onClick={() => act({ action: 'ADJUST_TRUST', trustDelta: 10, reason: 'Manual admin boost' })}
                className="flex-1 text-xs px-2 py-1 rounded border border-status-approved/30 text-status-approved hover:bg-status-approved-bg"
              >
                +10
              </button>
              <button
                disabled={loading}
                onClick={() => act({ action: 'ADJUST_TRUST', trustDelta: -10, reason: 'Manual admin penalty' })}
                className="flex-1 text-xs px-2 py-1 rounded border border-status-rejected/30 text-status-rejected hover:bg-status-rejected-bg"
              >
                -10
              </button>
            </div>
            <div className="flex gap-1.5 px-3 pb-2">
              <input
                type="number"
                value={customAmount}
                onChange={(e) => setCustomAmount(e.target.value)}
                placeholder="Custom ±"
                className="flex-1 min-w-0 px-2 py-1 rounded border border-border bg-bg-base text-xs text-text-primary placeholder:text-text-muted"
              />
              <button
                disabled={loading || !customAmount}
                onClick={applyCustomAmount}
                className="text-xs px-2 py-1 rounded border border-border text-text-primary hover:bg-bg-hover disabled:opacity-40 shrink-0"
              >
                Apply
              </button>
            </div>

            <div className="border-t border-border-subtle my-1" />
            <button
              disabled={loading}
              onClick={() => act({ action: isBanned ? 'UNBAN' : 'BAN' })}
              className="w-full text-left px-3 py-1.5 text-sm text-status-rejected hover:bg-bg-hover"
            >
              {isBanned ? 'Unban user' : 'Ban user'}
            </button>

            {/* Bulk comment removal — deliberately only offered once an
                account is actually banned (not just any user), matching
                what was asked for: a way to clear out a bad account's whole
                comment history at once, rather than a general-purpose bulk
                tool. Hidden entirely rather than shown-disabled when there's
                nothing to delete, since a 0-comment user has nothing useful
                to say about that state. commentCount comes from the same
                unfiltered _count this menu already trusts for submissions/
                verifications above — if some of this user's comments were
                already removed individually, this label can overcount
                (still includes those rows), but that only affects the
                number shown here, never what the server actually deletes
                (always exactly the still-live ones, re-checked fresh
                server-side — the success message after confirming will
                show the real number). */}
            {isBanned && commentCount > 0 && (
              <>
                <div className="border-t border-border-subtle my-1" />
                {!confirmingDeleteComments ? (
                  <button
                    disabled={loading}
                    onClick={() => setConfirmingDeleteComments(true)}
                    className="w-full text-left px-3 py-1.5 text-sm text-status-rejected hover:bg-bg-hover disabled:opacity-40"
                  >
                    Delete all comments ({commentCount})
                  </button>
                ) : (
                  <div className="px-3 py-1.5 space-y-1.5">
                    <p className="text-xs text-text-muted">
                      Delete every comment from this user, everywhere on the site? This can&apos;t be undone from here.
                    </p>
                    <div className="flex gap-1.5">
                      <button
                        disabled={loading}
                        onClick={() => act({ action: 'DELETE_COMMENTS' })}
                        className="flex-1 text-xs px-2 py-1 rounded border border-status-rejected/40 text-status-rejected hover:bg-status-rejected/10 disabled:opacity-40"
                      >
                        Confirm delete
                      </button>
                      <button
                        disabled={loading}
                        onClick={() => setConfirmingDeleteComments(false)}
                        className="flex-1 text-xs px-2 py-1 rounded border border-border text-text-primary hover:bg-bg-hover disabled:opacity-40"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
