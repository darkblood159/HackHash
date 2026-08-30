'use client';

// src/components/TagsEditor.tsx
import React, { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { SIMPLE_TAGS, ADVANCED_TAG_GROUPS, type TagDefinition } from '@/lib/tags';
import { Tooltip } from './ui/Tooltip';

interface TagsEditorProps {
  value: string[]; // slugs
  onChange: (slugs: string[]) => void;
  /** Shows a small "auto-filled" marker next to the label — same visual
   *  language as SubmitForm's other auto-filled fields. TagsEditor renders
   *  its own label (rather than relying on an outer Field wrapper) since
   *  it's also used directly inside AdminEditPanel, which has no such
   *  wrapper — this prop exists so SubmitForm doesn't need one either. */
  autoFilled?: boolean;
}

function TagButton({ tag, selected, onClick }: { tag: TagDefinition; selected: boolean; onClick: () => void }) {
  return (
    <Tooltip content={tag.description}>
      <button
        type="button"
        onClick={onClick}
        className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
          selected
            ? 'bg-phosphor/15 border-phosphor/40 text-phosphor'
            : 'bg-bg-base border-border text-text-muted hover:border-phosphor/30'
        }`}
      >
        {tag.name}
      </button>
    </Tooltip>
  );
}

export function TagsEditor({ value, onChange, autoFilled }: TagsEditorProps) {
  // Starts in advanced mode automatically if the current value already
  // includes an advanced-only tag, so opening this editor on an existing
  // submission never visually "hides" a tag it already has — same
  // "start in whichever mode matches what's on record" pattern already
  // used for the release-date year-only toggle elsewhere in this app.
  const [advanced, setAdvanced] = useState(
    () => value.some((slug) => !SIMPLE_TAGS.some((t) => t.slug === slug))
  );

  const toggle = (slug: string) => {
    onChange(value.includes(slug) ? value.filter((s) => s !== slug) : [...value, slug]);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="flex items-center gap-1.5 text-xs text-text-muted">
          Tags
          {autoFilled && (
            <span className="flex items-center gap-0.5 text-[10px] text-phosphor/80">
              <Sparkles size={10} /> auto-filled
            </span>
          )}
        </label>
        <div className="inline-flex rounded-md border border-border p-0.5 text-[11px]">
          <button
            type="button"
            onClick={() => setAdvanced(false)}
            className={`px-2 py-0.5 rounded transition-colors ${!advanced ? 'bg-phosphor/15 text-phosphor' : 'text-text-muted hover:text-text-secondary'}`}
          >
            Simple
          </button>
          <button
            type="button"
            onClick={() => setAdvanced(true)}
            className={`px-2 py-0.5 rounded transition-colors ${advanced ? 'bg-phosphor/15 text-phosphor' : 'text-text-muted hover:text-text-secondary'}`}
          >
            Advanced
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {SIMPLE_TAGS.map((tag) => (
          <TagButton key={tag.slug} tag={tag} selected={value.includes(tag.slug)} onClick={() => toggle(tag.slug)} />
        ))}
      </div>

      {advanced && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          {ADVANCED_TAG_GROUPS.map(({ group, tags }) => (
            <div key={group}>
              <p className="text-[10px] uppercase tracking-wider text-text-muted mb-1">{group}</p>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <TagButton key={tag.slug} tag={tag} selected={value.includes(tag.slug)} onClick={() => toggle(tag.slug)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
