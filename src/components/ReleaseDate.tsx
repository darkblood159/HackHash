'use client';

// src/components/ReleaseDate.tsx
import { useEffect, useState } from 'react';

// Formats a plain 'YYYY-MM-DD' string with the month spelled out (kills the
// "is 1/2/2000 January 2nd or February 1st" ambiguity outright, rather than
// just reordering the same ambiguous digits) using the given locale's own
// ordering/punctuation — e.g. "January 1, 2000" for en-US, "1 January 2000"
// for en-GB. Anchored at UTC so the calendar date can never shift a day
// depending on whichever timezone actually runs this — same class of bug
// resolveReleaseFields() (src/lib/hackFamily.ts) guards against when
// deriving a year FROM a date server-side.
export function formatReleaseDate(isoDate: string, locale?: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(date);
}

interface ReleaseDateProps {
  releaseDate: string | null | undefined; // 'YYYY-MM-DD'
  releaseYear: number | null | undefined; // legacy/unknown-precision fallback
  className?: string;
}

// Renders a full release date (spelled-out month, visitor-locale-ordered)
// when known, or falls back to just the year when that's all that's on
// record — never a bare numeric date, which is exactly the MM/DD-vs-DD/MM
// ambiguity this exists to avoid. Returns null (renders nothing) if
// neither is known.
//
// Deliberately its own small client component rather than formatting
// inline wherever a release date is shown: several pages that display one
// (the submission page, /entries) are SERVER components, and
// Intl/toLocaleDateString inside a server component reflects the SERVER's
// own locale, not the visitor's — a real, separate thing already true
// elsewhere in this app today (MappingsDisplay.tsx and
// HasheousSyncBadge.tsx both call toLocaleDateString() from inside
// server-rendered pages; not touched here, just noted since it's the same
// underlying issue this component is built to actually avoid). Genuinely
// reflecting the VISITOR's own region requires code that actually runs in
// their browser.
//
// The very first render — both the server's HTML and the client's first
// paint, which React requires to match exactly or it warns about a
// hydration mismatch — uses a fixed locale, not the visitor's real one.
// After mount, a useEffect (browser-only, never runs during SSR) swaps in
// the visitor's actual locale. In practice the date is always immediately
// readable and unambiguous either way; only which regional ordering
// convention it uses might visibly "snap" a moment after the page loads.
export default function ReleaseDate({ releaseDate, releaseYear, className }: ReleaseDateProps) {
  const fallbackLocaleDisplay = releaseDate ? formatReleaseDate(releaseDate, 'en-US') : releaseYear ? String(releaseYear) : null;
  const [display, setDisplay] = useState<string | null>(fallbackLocaleDisplay);

  useEffect(() => {
    if (releaseDate) setDisplay(formatReleaseDate(releaseDate));
  }, [releaseDate]);

  if (!display) return null;
  return <span className={className}>{display}</span>;
}
