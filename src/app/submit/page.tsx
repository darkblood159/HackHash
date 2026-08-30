// src/app/submit/page.tsx
import React from 'react';
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
      <SubmitForm />
    </div>
  );
}
