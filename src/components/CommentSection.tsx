'use client';

// src/components/CommentSection.tsx
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Avatar } from './ui/Avatar';
import { Button } from './ui/Button';
import { formatDistanceToNow } from 'date-fns';
import Link from 'next/link';

interface Comment {
  id: string;
  content: string;
  createdAt: string | Date;
  user: { id: string; name: string | null; image: string | null; role: string };
}

export function CommentSection({
  submissionId,
  comments,
  canComment,
}: {
  submissionId: string;
  comments: Comment[];
  canComment: boolean;
}) {
  const router = useRouter();
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!content.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/submissions/${submissionId}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (res.ok) {
        setContent('');
        router.refresh();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-5 rounded-lg border border-border bg-bg-surface">
      <h2 className="text-sm font-semibold text-text-primary mb-4">
        Discussion ({comments.length})
      </h2>

      <div className="space-y-4 mb-5">
        {comments.length === 0 && <p className="text-sm text-text-muted">No comments yet.</p>}
        {comments.map((c) => (
          <div key={c.id} className="flex items-start gap-3">
            <Avatar src={c.user.image} name={c.user.name} size={28} />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2">
                <Link href={`/profile/${c.user.id}`} className="text-sm font-medium text-text-primary hover:text-phosphor">
                  {c.user.name}
                </Link>
                {c.user.role === 'ADMINISTRATOR' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-phosphor/10 text-phosphor">Admin</span>
                )}
                <span className="text-xs text-text-muted">{formatDistanceToNow(new Date(c.createdAt), { addSuffix: true })}</span>
              </div>
              <p className="text-sm text-text-secondary mt-1 whitespace-pre-wrap">{c.content}</p>
            </div>
          </div>
        ))}
      </div>

      {canComment ? (
        <div className="flex gap-2">
          <input
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Add a comment…"
            className="flex-1 px-3 py-2 rounded-md bg-bg-base border border-border text-sm placeholder:text-text-muted"
          />
          <Button size="sm" loading={submitting} onClick={submit}>Post</Button>
        </div>
      ) : (
        <p className="text-xs text-text-muted">Sign in to join the discussion.</p>
      )}
    </div>
  );
}
