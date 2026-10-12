// src/app/api/admin/authors/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { cleanAuthorName, authorNameKey, AUTHOR_NAME_MAX, refreshAuthorCache, deleteAuthorAndRefreshCache } from '@/lib/author';

const patchSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter an author name').max(300).optional(),
    approve: z.boolean().optional(),
  })
  .refine((d) => d.name !== undefined || d.approve === true, { message: 'Nothing to change' });

// PATCH /api/admin/authors/[id]  { name?, approve? }
//
// Rename and/or approve. Renaming recomputes the dedupe key too, and is
// refused (409) if the new name would collide with a DIFFERENT existing
// author — the right move there is merging the two, not renaming one into
// the other's identity (see the merge route next door). Unlike renaming a
// Franchise, a rename here ALSO has to update every submission currently
// linked to this author (a SubmissionAuthor row pointing at this one):
// Submission.author is a denormalized cache of its linked authors' names
// (see that field's comment in prisma/schema.prisma), and a rename that
// didn't push through to it would leave every linked hack silently showing
// the OLD name in search, DAT export, and everywhere else that reads the
// string directly instead of joining through the links. With several
// authors per hack the string is rebuilt from ALL of a hack's links (not
// just text-replaced), so a co-credited hack keeps its other names and its
// order. Both writes happen in one transaction so they can't disagree even
// if the second half failed.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const author = await prisma.author.findUnique({ where: { id: params.id } });
  if (!author) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message ?? 'Invalid request' }, { status: 400 });
  }

  const data: { name?: string; nameKey?: string; status?: 'APPROVED'; approvedById?: string; approvedAt?: Date } = {};

  if (parsed.data.name !== undefined) {
    const name = cleanAuthorName(parsed.data.name);
    const nameKey = authorNameKey(name);
    if (!nameKey) {
      return NextResponse.json({ error: 'An author name needs at least one letter or number.' }, { status: 400 });
    }
    if (name.length > AUTHOR_NAME_MAX) {
      return NextResponse.json({ error: `Author names can be at most ${AUTHOR_NAME_MAX} characters.` }, { status: 400 });
    }
    const clash = await prisma.author.findUnique({ where: { nameKey }, select: { id: true, name: true } });
    if (clash && clash.id !== author.id) {
      return NextResponse.json(
        { error: `An author called "${clash.name}" already exists — merge this one into it instead of renaming.`, existingId: clash.id },
        { status: 409 }
      );
    }
    data.name = name;
    data.nameKey = nameKey;
  }

  const approving = parsed.data.approve === true && author.status !== 'APPROVED';
  if (approving) {
    data.status = 'APPROVED';
    data.approvedById = session.user.id;
    data.approvedAt = new Date();
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ ok: true, unchanged: true });
  }

  let renamedSubmissions = 0;
  try {
    renamedSubmissions = await prisma.$transaction(async (tx) => {
      await tx.author.update({ where: { id: params.id }, data });
      if (data.name !== undefined) {
        // Raw UPDATE inside refreshAuthorCache on purpose — a bookkeeping
        // rewrite must not stamp "now" into Submission.updatedAt (hack-family
        // aggregation reads it as "most recently edited").
        return refreshAuthorCache(tx, { authorId: params.id });
      }
      return 0;
    });
  } catch (err: any) {
    // Lost a race with someone creating/renaming to the same key between
    // the clash check above and this write.
    if (err?.code === 'P2002') {
      return NextResponse.json({ error: 'An author with that name already exists — merge instead of renaming.' }, { status: 409 });
    }
    throw err;
  }

  if (data.name !== undefined && data.name !== author.name) {
    await prisma.auditLog.create({
      data: {
        action: 'AUTHOR_RENAMED',
        details: { authorId: params.id, from: author.name, to: data.name, renamedSubmissions },
        userId: session.user.id,
      },
    });
  }
  if (approving) {
    await prisma.auditLog.create({
      data: {
        action: 'AUTHOR_APPROVED',
        details: { authorId: params.id, name: data.name ?? author.name },
        userId: session.user.id,
      },
    });
  }

  return NextResponse.json({ ok: true });
}

// DELETE /api/admin/authors/[id]
//
// A real delete, not a soft one — same deliberate departure from the
// project's usual soft-delete default that Franchise removal makes, for the
// same reason: nameKey is globally unique, so a soft-deleted row would keep
// occupying that name forever and block anyone from ever re-creating it.
// Never blocked when submissions still use it: authors are optional on a
// submission, so the database's ON DELETE CASCADE on SubmissionAuthor simply
// removes the links. A hack that credited ONLY this author keeps its
// `author` string — that column is meaningful free text in its own right (it
// predates this entity and is what search/export/display actually read), and
// losing the last-known name just because the governed row behind it went
// away would be a real, visible regression for something removal doesn't
// otherwise touch at all. A hack that ALSO credits other authors has its
// string rebuilt from the ones that remain, so the string never names someone
// the hack is no longer linked to. The audit entry records how many links
// were removed so it's clear afterward what a removal touched.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const author = await prisma.author.findUnique({ where: { id: params.id } });
  if (!author) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Read for the audit entry only; deleteAuthorAndRefreshCache below looks the
  // affected hacks up again inside its own transaction (the one that matters).
  const unlinkedSubmissions = await prisma.submissionAuthor.count({ where: { authorId: params.id } });

  // Audit first: AuditLog.details is plain Json with no FK to Author, so
  // the entry survives the row being gone with no orphan concern — same
  // ordering franchise/base-rom removal use.
  await prisma.auditLog.create({
    data: {
      action: 'AUTHOR_REMOVED',
      details: { authorId: params.id, name: author.name, status: author.status, unlinkedSubmissions },
      userId: session.user.id,
    },
  });

  await prisma.$transaction((tx) => deleteAuthorAndRefreshCache(tx, params.id));

  return NextResponse.json({ ok: true, unlinkedSubmissions });
}
