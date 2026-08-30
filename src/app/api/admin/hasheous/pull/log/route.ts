// src/app/api/admin/hasheous/pull/log/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { jobStore } from '@/lib/jobStore';

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== 'ADMINISTRATOR') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get('id');
  if (!jobId) return NextResponse.json({ error: 'Missing job id' }, { status: 400 });

  const job = jobStore.get(jobId);
  if (!job) return NextResponse.json({ error: 'Job not found (in-memory jobs are lost on server restart)' }, { status: 404 });

  const lines: string[] = [];
  lines.push(`Hasheous pull job ${job.id}`);
  lines.push(`Environment: ${job.env}`);
  lines.push(`Started: ${job.startedAt}`);
  lines.push(`Finished: ${job.finishedAt ?? '(still running)'}`);
  lines.push(`Status: ${job.status}`);
  lines.push(`Total processed: ${job.processed} / ${job.total}`);
  lines.push(`Found in Hasheous: ${job.found}`);
  lines.push(`Updated with new data: ${job.updated}`);
  lines.push(`Not found in Hasheous: ${job.notFound}`);
  lines.push('');

  const updated = job.foundResults.filter((r) => (r.mappingsApplied?.length ?? 0) > 0);
  const foundNoNewData = job.foundResults.filter((r) => !(r.mappingsApplied?.length));

  lines.push(`=== UPDATED (${updated.length}) — found in Hasheous with new mapping data applied ===`);
  for (const r of updated) {
    lines.push(`${r.hackName}\t${r.sha1}\t${r.mappingsApplied!.join(', ')}`);
  }
  lines.push('');

  lines.push(`=== FOUND, NO NEW DATA (${foundNoNewData.length}) — already synced or Hasheous has no extra mappings ===`);
  for (const r of foundNoNewData) {
    lines.push(`${r.hackName}\t${r.sha1}`);
  }
  lines.push('');

  lines.push(`=== NOT FOUND (${job.notFoundResults.length}) — no match in Hasheous for this hash ===`);
  for (const r of job.notFoundResults) {
    lines.push(`${r.hackName}\t${r.sha1}`);
  }

  const text = lines.join('\n');

  return new NextResponse(text, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="hasheous-pull-${job.id}.txt"`,
    },
  });
}
