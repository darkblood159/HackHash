// src/app/api/submissions/[id]/formats/[formatId]/review/route.ts
//
// Confirms or rejects an alternate-format entry (see the AlternateFormat
// model's own comment in prisma/schema.prisma). Gated by canCastManualVote
// — the SAME Verifier/Administrator/Veteran-trust-tier bar as the main
// submission's own "manual vote" path — not the admin-only bar used by
// BaseRom's approve/reject routes, because reviewing one of these is the
// same "I vouch for this based on my own review" shape as a manual vote
// (the reviewer is expected to have separately decoded the file with their
// own external tool and confirmed it matches), not the curation-of-a-
// shared-cross-submission-entity shape BaseRom review actually is.
//
// Deliberately allows re-reviewing an already-decided entry at any time
// (no PENDING-only guard) — mirrors BaseRom's own approve/reject routes,
// which have the same freedom to correct an earlier decision.
//
// `verifiedHash` (added for the drag-and-drop auto-verify flow — see
// AlternateFormats.tsx and admin/alternate-formats/page.tsx): mirrors
// src/lib/approval.ts's checkAutoApproval `hasVeteranMatch` rule for the
// PRIMARY submission — a single Veteran-tier-or-above (or Verifier,
// Administrator) hash match is ALREADY enough to auto-approve there, no
// separate vote-counting needed. Same trust bar already gates who can call
// this route at all, so the same "one real match from someone qualified is
// sufficient" principle applies here directly: when a qualified reviewer's
// browser reports a match, the caller (see the two components above) sends
// that claimed hash along with `approve: true` and this route auto-fires
// with NO extra confirmation step. The claimed hash is NEVER trusted at
// face value, though — a client asserting "it matched" proves nothing on
// its own, so it's independently re-compared against this entry's own
// stored crc32/md5/sha1 below before being honored at all. Deliberately
// does NOT extend the same automation to rejections — a claimed mismatch
// only ever produces an informational result in the UI, never an automatic
// reject, because a mismatch is genuinely ambiguous (could mean the
// reviewer's own file is wrong, not the entry) in a way a match isn't.
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canCastManualVote, triggerHasheousPushForAlternateFormat } from '@/lib/approval';
import { z } from 'zod';

const reviewSchema = z.object({
  approve: z.boolean(),
  rejectionReason: z.string().max(500).optional(),
  verifiedHash: z.object({
    crc32: z.string().regex(/^[0-9a-f]{8}$/i),
    md5: z.string().regex(/^[0-9a-f]{32}$/i),
    sha1: z.string().regex(/^[0-9a-f]{40}$/i),
  }).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; formatId: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }
  if (session.user.isBanned) {
    return NextResponse.json({ error: 'Your account has been banned' }, { status: 403 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { trustScore: true, role: true },
  });
  if (!canCastManualVote(user?.role ?? 'GUEST', user?.trustScore ?? 0)) {
    return NextResponse.json(
      { error: 'Reviewing an alternate format requires the Verifier role, Administrator role, or Veteran trust tier' },
      { status: 403 }
    );
  }

  const entry = await prisma.alternateFormat.findUnique({ where: { id: params.formatId } });
  if (!entry || entry.submissionId !== params.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Same independence guarantee as "cannot verify your own submission" —
  // someone else has to be the one confirming this. Administrators are the
  // one deliberate exception: on a small site the admin is very often the
  // same person doing the uploading, and there's no one else to hand this
  // off to — unlike a Verifier or Veteran-tier reviewer, an admin can also
  // just directly inspect/decode the file themselves with full authority
  // over the site regardless, so withholding this specifically for admins
  // protects against a scenario (an admin rubber-stamping their own bad
  // upload) they could just as easily bypass through other admin tools
  // anyway. Non-admin reviewers (Verifier role, Veteran trust tier) still
  // cannot review their own — the independence guarantee stays real for them.
  if (entry.addedById === session.user.id && user?.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'You cannot review a format you added yourself' }, { status: 403 });
  }

  const parsed = reviewSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 });
  }

  let verifiedByHash = false;
  if (parsed.data.verifiedHash) {
    if (!parsed.data.approve) {
      return NextResponse.json(
        { error: 'A verified hash can only accompany an approval, not a rejection' },
        { status: 422 }
      );
    }
    const claimed = parsed.data.verifiedHash;
    const actuallyMatches =
      claimed.crc32.toLowerCase() === entry.crc32.toLowerCase() &&
      claimed.md5.toLowerCase() === entry.md5.toLowerCase() &&
      claimed.sha1.toLowerCase() === entry.sha1.toLowerCase();
    if (!actuallyMatches) {
      // The claim doesn't hold up under an independent check — refuse
      // rather than silently approving anyway on the strength of `approve:
      // true` alone. This is what keeps auto-verify honest: the SERVER
      // decides whether a match is real, never the client's own say-so.
      return NextResponse.json(
        { error: "Those hashes don't actually match this entry — nothing was changed" },
        { status: 422 }
      );
    }
    verifiedByHash = true;
  }

  const updated = await prisma.alternateFormat.update({
    where: { id: entry.id },
    data: {
      status: parsed.data.approve ? 'APPROVED' : 'REJECTED',
      reviewedById: session.user.id,
      reviewedAt: new Date(),
      rejectionReason: parsed.data.approve ? null : (parsed.data.rejectionReason ?? null),
      verifiedByHash,
    },
  });

  await prisma.auditLog.create({
    data: {
      action: parsed.data.approve ? 'ALTERNATE_FORMAT_APPROVED' : 'ALTERNATE_FORMAT_REJECTED',
      details: { alternateFormatId: entry.id, format: entry.format, reason: parsed.data.rejectionReason, verifiedByHash },
      userId: session.user.id,
      submissionId: params.id,
    },
  });

  // Fire-and-forget, same rule as every other Hasheous push trigger in this
  // app (see approval.ts) — an external HTTP call must never make this
  // response slower or fail because Hasheous is slow/unavailable. Only on
  // approval: a rejected claim was never actually this game's content, so
  // there's nothing correct to push.
  if (parsed.data.approve) {
    void triggerHasheousPushForAlternateFormat(entry.id);
  }

  return NextResponse.json({ ok: true, status: updated.status });
}
