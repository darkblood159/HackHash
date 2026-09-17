// src/app/submit/page.tsx
import React, { Suspense } from 'react';
import { SubmitForm } from '@/components/SubmitForm';

export const metadata = {
  title: 'Submit a ROM hack — HackHash',
};

export default function SubmitPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
      <div className="mb-10">
        <span className="text-phosphor text-xs font-mono uppercase tracking-widest">New submission</span>
        <h1 className="font-display text-3xl font-bold mt-2">Submit a ROM hack</h1>
        <p className="text-text-secondary mt-2 max-w-xl">
          Hash your file locally, fill in what you know, and the community takes it from there.
          Your ROM never leaves this browser tab.
        </p>
      </div>
      {/* useSearchParams() (used below to read ?fromSubmission=) requires a
          Suspense boundary in the App Router, or `next build` fails static
          generation for this page — same fix already applied to
          /auth/signin and /auth/error for the same reason. */}
      <Suspense fallback={<div className="h-24 rounded-lg bg-bg-elevated border border-border animate-pulse" />}>
        <SubmitForm />
      </Suspense>
    </div>
  );
}
