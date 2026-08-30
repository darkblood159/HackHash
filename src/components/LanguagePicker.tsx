'use client';

// src/components/LanguagePicker.tsx
//
// Multi-select chip picker for Submission.translationLanguages. Rendered
// conditionally by the parent (SubmitForm / AdminEditPanel) whenever the
// current tag selection intersects TRANSLATION_TRIGGER_SLUGS (see
// src/lib/tags.ts) — this component itself doesn't know about tags at
// all, it's just a plain multi-select over src/lib/languages.ts.

import React from 'react';
import { LANGUAGES } from '@/lib/languages';

interface LanguagePickerProps {
  value: string[]; // language codes
  onChange: (codes: string[]) => void;
}

export function LanguagePicker({ value, onChange }: LanguagePickerProps) {
  const toggle = (code: string) => {
    onChange(value.includes(code) ? value.filter((c) => c !== code) : [...value, code]);
  };

  return (
    <div>
      <label className="block text-xs text-text-muted mb-1.5">Translated into</label>
      <div className="flex flex-wrap gap-1.5">
        {LANGUAGES.map((lang) => (
          <button
            key={lang.code}
            type="button"
            onClick={() => toggle(lang.code)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              value.includes(lang.code)
                ? 'bg-phosphor/15 border-phosphor/40 text-phosphor'
                : 'bg-bg-base border-border text-text-muted hover:border-phosphor/30'
            }`}
          >
            {lang.name}
          </button>
        ))}
      </div>
    </div>
  );
}
