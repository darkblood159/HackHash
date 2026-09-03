'use client';

// src/components/CommentSection.tsx
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Avatar } from './ui/Avatar';
import { Button } from './ui/Button';
import { formatDistanceToNow } from 'date-fns';
import Link from 'next/link';
import { Trash2 } from 'lucide-react';

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
  isAdmin = false,
}: {
  submissionId: string;
  comments: Comment[];
  canComment: boolean;
  isAdmin?: boolean;
}) {
  const router = useRouter();
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Which single comment currently has its "Delete this comment?" confirm
  // showing, and which one (if any) has a delete request actually in
  // flight. Kept separate, and both scoped to one comment id at a time —
  // opening a confirm on a different comment implicitly closes any other,
  // matching the mutually-exclusive inline-confirm pattern already used on
  // /admin/base-roms (Edit/Reject/Remove on the same row).
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  const deleteComment = async (commentId: string) => {
    setDeletingId(commentId);
    try {
      const res = await fetch(`/api/admin/comments/${commentId}`, { method: 'DELETE' });
      if (res.ok) {
        setConfirmingId(null);
        router.refresh();
      }
    } finally {
      setDeletingId(null);
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
            {isAdmin && (
              confirmingId === c.id ? (
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    disabled={deletingId === c.id}
                    onClick={() => deleteComment(c.id)}
                    className="text-[11px] px-2 py-1 rounded border border-status-rejected/40 text-status-rejected hover:bg-status-rejected/10 disabled:opacity-50"
                  >
                    {deletingId === c.id ? 'Deleting…' : 'Confirm'}
                  </button>
                  <button
                    disabled={deletingId === c.id}
                    onClick={() => setConfirmingId(null)}
                    className="text-[11px] px-2 py-1 rounded border border-border text-text-muted hover:bg-bg-hover disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmingId(c.id)}
                  title="Delete comment"
                  className="shrink-0 p-1 rounded-md text-text-muted hover:text-status-rejected hover:bg-status-rejected/10 transition-colors"
                >
                  <Trash2 size={13} />
                </button>
              )
            )}
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
