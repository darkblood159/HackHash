'use client';

// src/components/AuthorsPicker.tsx
//
// Picks the people/teams credited with a hack — one OR MORE, in credit order.
// The chosen authors are shown as a list (first = the primary credit, with
// move-up / move-down / remove on each), and below it sits the existing
// AuthorPicker used purely as an "add one more" search box: value is always
// null there, so it stays in search mode, and a pick or a freshly proposed
// author is appended here. All the search / near-match / propose-new logic
// stays in AuthorPicker (see its own comment) — nothing is duplicated.
//
// Order is changed with arrow buttons rather than drag-and-drop on purpose:
// most people use this on a phone, where dragging inside a scrolling form is
// unreliable, and the buttons are keyboard-accessible for free.
//
// Controlled: the parent owns `value`. Every change calls onChange with the
// complete new ordered list, so the parent can send it as-is (the server
// treats the array as the full replacement list).

import { useRef } from 'react';
import { ChevronUp, ChevronDown, X } from 'lucide-react';
import { AuthorPicker, type SelectedAuthor } from './AuthorPicker';
import { MAX_AUTHORS_PER_SUBMISSION } from '@/lib/authorList';

export type { SelectedAuthor };

interface AuthorsPickerProps {
  value: SelectedAuthor[];
  onChange: (value: SelectedAuthor[]) => void;
  max?: number;
  placeholder?: string;
  // Pre-fills the search box on first render while nothing is picked yet — see
  // the matching prop on AuthorPicker (a submission whose author is plain text
  // with no linked rows).
  initialQuery?: string;
}

// True when two lists name the same authors in the same order — what every
// "did the author change?" check needs (a reorder IS a change, since order is
// the credit order).
export function sameAuthorList(a: Array<{ id: string }>, b: Array<{ id: string }>): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i].id);
}

export function AuthorsPicker({ value, onChange, max = MAX_AUTHORS_PER_SUBMISSION, placeholder, initialQuery }: AuthorsPickerProps) {
  // The add handler can fire after an await inside AuthorPicker (proposing a
  // new author is a network call). Reading the list from a ref that is
  // refreshed on every render means that late call appends to the CURRENT
  // list — not the one captured when the request started, which would
  // silently undo a remove/reorder done in the meantime.
  const valueRef = useRef(value);
  valueRef.current = value;

  function add(author: SelectedAuthor) {
    const current = valueRef.current;
    if (current.some((a) => a.id === author.id) || current.length >= max) return;
    onChange([...current, { id: author.id, name: author.name, status: author.status }]);
  }

  function removeAt(index: number) {
    onChange(valueRef.current.filter((_, i) => i !== index));
  }

  function move(index: number, delta: -1 | 1) {
    const current = valueRef.current;
    const target = index + delta;
    if (target < 0 || target >= current.length) return;
    const next = [...current];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  const atMax = value.length >= max;

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="space-y-1.5">
          {value.map((a, i) => (
            <li
              key={a.id}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-bg-base border border-border text-xs text-text-primary"
            >
              <span className="truncate">{a.name}</span>
              {i === 0 && value.length > 1 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-phosphor/10 text-phosphor shrink-0">primary</span>
              )}
              {a.status === 'PENDING' && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-pending-bg text-status-pending shrink-0">pending review</span>
              )}
              <span className="ml-auto flex items-center shrink-0">
                {value.length > 1 && (
                  <>
                    <button
                      type="button"
                      onClick={() => move(i, -1)}
                      disabled={i === 0}
                      aria-label={`Move ${a.name} up`}
                      className="p-2 text-text-muted hover:text-phosphor disabled:opacity-30 disabled:hover:text-text-muted"
                    >
                      <ChevronUp size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(i, 1)}
                      disabled={i === value.length - 1}
                      aria-label={`Move ${a.name} down`}
                      className="p-2 text-text-muted hover:text-phosphor disabled:opacity-30 disabled:hover:text-text-muted"
                    >
                      <ChevronDown size={14} />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => removeAt(i)}
                  aria-label={`Remove ${a.name}`}
                  className="p-2 text-text-muted hover:text-status-rejected"
                >
                  <X size={14} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {atMax ? (
        <p className="text-xs text-text-muted">That&rsquo;s the maximum of {max} authors for one hack.</p>
      ) : (
        <AuthorPicker
          value={null}
          onChange={(a) => { if (a) add(a); }}
          excludeIds={value.map((a) => a.id)}
          placeholder={value.length > 0 ? 'Add another author…' : placeholder}
          initialQuery={value.length === 0 ? initialQuery : undefined}
        />
      )}

      {value.length > 1 && (
        <p className="text-[11px] text-text-muted">The first author listed is the primary credit. Use the arrows to reorder.</p>
      )}
    </div>
  );
}
