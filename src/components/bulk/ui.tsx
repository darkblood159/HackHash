// src/components/bulk/ui.tsx
//
// Small presentational pieces shared by the bulk-submit components. `Field`
// and `inputClass` match the single form's own (they're local to
// SubmitForm.tsx, which this change deliberately leaves untouched) so the two
// screens look the same.
import React, { useRef, useState } from 'react';
import { Sparkles, UploadCloud } from 'lucide-react';

export const inputClass =
  'w-full px-3 py-2 rounded-md bg-bg-surface border border-border text-text-primary text-sm placeholder:text-text-muted focus:border-phosphor/50 transition-colors disabled:opacity-60';

export function Field({
  label,
  required,
  hint,
  autoFilled,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  /** Shows the same small "auto-filled" marker the single form uses: the site filled this in, please check it. */
  autoFilled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="flex items-center gap-1.5 text-sm font-medium text-text-primary mb-1.5">
        {label} {required && <span className="text-phosphor">*</span>}
        {autoFilled && (
          <span className="flex items-center gap-0.5 text-[10px] font-normal text-phosphor/80 normal-case tracking-normal">
            <Sparkles size={10} /> auto-filled
          </span>
        )}
      </label>
      {children}
      {hint && <p className="text-xs text-text-muted mt-1">{hint}</p>}
    </div>
  );
}

/**
 * Click, keyboard (Enter/Space) or drag-and-drop file chooser. Hands the
 * chosen files straight back — hashing and archive reading happen elsewhere,
 * and nothing is uploaded from here.
 */
export function BulkDropZone({
  label,
  hint,
  onFiles,
  disabled,
  multiple = true,
  compact,
}: {
  label: string;
  hint?: string;
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  multiple?: boolean;
  compact?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const take = (list: FileList | null) => {
    if (disabled || !list || list.length === 0) return;
    onFiles(Array.from(list));
  };

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label={label}
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        take(e.dataTransfer.files);
      }}
      className={[
        'rounded-lg border-2 border-dashed text-center cursor-pointer transition-colors',
        'focus-visible:outline-none focus-visible:border-phosphor focus-visible:ring-2 focus-visible:ring-phosphor/30',
        compact ? 'px-4 py-4' : 'px-4 py-8',
        dragging ? 'border-phosphor bg-phosphor/10' : 'border-border hover:border-phosphor/50 bg-bg-surface',
        disabled ? 'opacity-50 cursor-not-allowed' : '',
      ].join(' ')}
    >
      <input
        ref={inputRef}
        type="file"
        multiple={multiple}
        className="hidden"
        disabled={disabled}
        onChange={(e) => {
          take(e.target.files);
          e.target.value = ''; // so choosing the same file again still fires
        }}
      />
      <UploadCloud size={compact ? 18 : 22} className="mx-auto text-phosphor mb-1.5" />
      <p className="text-sm text-text-primary font-medium">{label}</p>
      {hint && <p className="text-xs text-text-muted mt-1 max-w-md mx-auto">{hint}</p>}
    </div>
  );
}
