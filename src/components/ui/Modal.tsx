'use client';

// src/components/ui/Modal.tsx
//
// First modal/dialog in this codebase — built for the patch-apply flow
// (PatchApplyButton.tsx) but deliberately generic, not specific to it, so
// anything else that needs one later can reuse this rather than growing
// its own. Portal-rendered to document.body so it's never clipped by an
// ancestor's overflow/z-index (a card with overflow:hidden, for example),
// closes on Escape or backdrop click, and locks body scroll while open so
// the page behind it doesn't scroll along with it.

import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { X } from 'lucide-react';

export function Modal({
  open,
  onClose,
  title,
  maxWidthClassName = 'max-w-sm',
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  maxWidthClassName?: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={clsx(
          'relative w-full rounded-lg border border-border bg-bg-surface p-5 shadow-card-hover animate-fade-in',
          maxWidthClassName
        )}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-text-muted hover:bg-bg-elevated hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}
