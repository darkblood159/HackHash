// src/app/submit/bulk/page.tsx
//
// Submit several versions of one hack (and their patches) in one sitting.
// See src/components/bulk/BulkSubmitForm.tsx for what it does and what it
// deliberately does NOT change about how submissions are reviewed.
import React, { Suspense } from 'react';
import Link from 'next/link';
import { BulkSubmitForm } from '@/components/bulk/BulkSubmitForm';

export const metadata = {
  title: 'Submit several versions — HackHash',
};

export default function BulkSubmitPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
      <div className="mb-10">
        <span className="text-phosphor text-xs font-mono uppercase tracking-widest">New submission</span>
        <h1 className="font-display text-3xl font-bold mt-2">Submit several versions</h1>
        <p className="text-text-secondary mt-2 max-w-xl">
          Enter the hack&apos;s details once, drop every version&apos;s ROM (and patch) in, and check the list.
          Your ROMs are read in this browser and never uploaded; only the details you enter, their hashes, and any
          patch files you add are sent. Every version is still verified by the community like any other submission.
        </p>
        <p className="text-xs text-text-muted mt-3">
          Only have one version? <Link href="/submit" className="text-phosphor hover:underline">Submit it here</Link>.
        </p>
      </div>
      {/* useSearchParams() (reads ?from=) needs a Suspense boundary in the
          App Router, same as /submit. */}
      <Suspense fallback={<div className="h-24 rounded-lg bg-bg-elevated border border-border animate-pulse" />}>
        <BulkSubmitForm />
      </Suspense>
    </div>
  );
}
