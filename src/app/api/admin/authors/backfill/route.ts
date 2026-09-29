// src/app/api/admin/authors/backfill/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { cleanAuthorName, authorNameKey, resolveOrCreateAuthor } from '@/lib/author';

// POST /api/admin/authors/backfill
//
// One-time (but safe to re-run) linking pass for submissions that predate
// the Author list, or were imported/edited outside the picker: any
// submission with a free-text `author` but no authorId yet. Same shape as
// /api/admin/hack-families/backfill, adapted for Author's extra denormalized
// text column (see the long comment atop src/lib/author.ts).
//
// Groups candidates by authorNameKey() — the same matching key
// resolveOrCreateAuthor() itself uses — so "RomHacker99", "romhacker99" and
// "Rom Hacker  99" converge on ONE Author row instead of three, exactly as
// if they'd been typed into the picker one at a time and deduped there.
//
// For each distinct key, resolveOrCreateAuthor() either reuses an Author
// that already has it (created earlier through the normal picker flow —
// promoting it to APPROVED if it was still PENDING, same "this clearly
// already has real history" reasoning that function's own promotion path
// documents for the DAT importer) or creates a fresh one, already APPROVED:
// these names have been live and visible on real hacks, sometimes for
// years: there's nothing left to review.
//
// Every linked submission's `author` text is then overwritten to the
// resolved Author's exact current name — same full-replace AUTHOR_MERGED
// already does — because author.ts's own top comment documents that string
// as a cache that must always match the linked Author's CURRENT name, never
// whichever of several spellings a given submission happened to be typed
// with originally.
//
// Only touches submissions with authorId still null and a non-blank author
// string, so it's safe to call again later (e.g. after a bulk DAT import
// adds more legacy rows) — already-linked submissions are left alone.
// Soft-deleted submissions (deletedAt set) are excluded, same convention the
// admin authors list's own usage count already uses.
export async function POST(_req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const candidates = await prisma.submission.findMany({
    where: { authorId: null, author: { not: null }, deletedAt: null },
    select: { id: true, author: true, updatedAt: true },
  });

  type Candidate = { id: string; author: string; updatedAt: Date };
  const usable: Candidate[] = [];
  // Cleaned name -> how many submissions used it. Covers the (expected to
  // be rare) legacy text that can't become a key at all — pure punctuation/
  // symbols with no letter, mark or digit in any script, e.g. "-" or "???".
  // Those submissions are left exactly as they are; nothing about them
  // changes, same as any other row this pass doesn't touch.
  const skippedNames = new Map<string, number>();

  for (const c of candidates) {
    const cleaned = cleanAuthorName(c.author ?? '');
    if (!cleaned) continue; // whitespace-only text — not worth reporting
    if (!authorNameKey(cleaned)) {
      skippedNames.set(cleaned, (skippedNames.get(cleaned) ?? 0) + 1);
      continue;
    }
    usable.push({ id: c.id, author: cleaned, updatedAt: c.updatedAt });
  }

  const skippedTotal = Array.from(skippedNames.values()).reduce((a, b) => a + b, 0);
  const skippedSample = Array.from(skippedNames.keys()).slice(0, 25);

  if (usable.length === 0) {
    return NextResponse.json({
      authorsCreated: 0, authorsPromoted: 0, authorsReused: 0, submissionsLinked: 0,
      skippedTotal, skippedSample, failedGroups: [],
    });
  }

  const groups = new Map<string, Candidate[]>();
  for (const c of usable) {
    const key = authorNameKey(c.author);
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }

  let authorsCreated = 0;
  let authorsPromoted = 0;
  let authorsReused = 0;
  let submissionsLinked = 0;
  const failedGroups: Array<{ name: string; error: string }> = [];

  for (const members of Array.from(groups.values())) {
    // Representative display name for a genuinely NEW Author row: the most
    // common exact spelling in the group, tie-broken by whichever was most
    // recently touched — same tie-break hack-families/backfill uses for its
    // own "representative" pick. Irrelevant when the key already matches an
    // existing Author — resolveOrCreateAuthor keeps that row's own name.
    const counts = new Map<string, { count: number; latest: number }>();
    for (const m of members) {
      const entry = counts.get(m.author) ?? { count: 0, latest: 0 };
      entry.count += 1;
      entry.latest = Math.max(entry.latest, m.updatedAt.getTime());
      counts.set(m.author, entry);
    }
    const representativeName = Array.from(counts.entries()).sort(
      (a, b) => b[1].count - a[1].count || b[1].latest - a[1].latest
    )[0][0];

    try {
      const resolved = await resolveOrCreateAuthor(prisma, {
        name: representativeName,
        submittedById: null, // nobody personally submitted this — it's a backfill of existing catalogue data
        status: 'APPROVED',
        approvedById: session.user.id,
        approvedAt: new Date(),
      });

      if (resolved.isNew) authorsCreated++;
      else if (resolved.promoted) authorsPromoted++;
      else authorsReused++;

      await prisma.submission.updateMany({
        where: { id: { in: members.map((m) => m.id) } },
        data: { authorId: resolved.authorId, author: resolved.name },
      });
      submissionsLinked += members.length;
    } catch (err: any) {
      // One malformed group (unexpected at this point — length is already
      // bounded by the free-text column's own 200-char cap, see
      // AUTHOR_NAME_MAX's comment in src/lib/author.ts) shouldn't lose
      // progress already made on every other group.
      failedGroups.push({ name: representativeName, error: err?.message ?? 'Unknown error' });
    }
  }

  await prisma.auditLog.create({
    data: {
      action: 'AUTHORS_BACKFILLED',
      details: {
        authorsCreated, authorsPromoted, authorsReused, submissionsLinked,
        skippedTotal, skippedSample, failedGroups,
      },
      userId: session.user.id,
    },
  });

  return NextResponse.json({
    authorsCreated, authorsPromoted, authorsReused, submissionsLinked,
    skippedTotal, skippedSample, failedGroups,
  });
}
