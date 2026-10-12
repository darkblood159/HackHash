// src/components/AuthorLinks.tsx
//
// Renders a hack's credited authors as individual links to "everything by
// this author" (`${basePath}?author=<name>`), joined with the same separator
// the stored `author` string uses. A hack with no linked authors (plain-text
// author, from before the Author list) falls back to ONE link on that string,
// exactly what these lists showed before a hack could credit several. A server
// component on purpose: it has no state, and list pages render many of them.

import Link from 'next/link';
import { AUTHOR_SEPARATOR } from '@/lib/authorList';

interface AuthorLinksProps {
  authors: Array<{ id: string; name: string }>;
  /** The plain `author` string, shown when `authors` is empty. */
  fallback: string | null;
  basePath: '/entries' | '/submissions';
  linkClassName?: string;
}

export function AuthorLinks({ authors, fallback, basePath, linkClassName }: AuthorLinksProps) {
  const href = (name: string) => `${basePath}?author=${encodeURIComponent(name)}`;
  if (authors.length === 0) {
    if (!fallback) return null;
    return <Link href={href(fallback)} className={linkClassName}>{fallback}</Link>;
  }
  return (
    <>
      {authors.map((a, i) => (
        <span key={a.id}>
          {i > 0 && AUTHOR_SEPARATOR}
          <Link href={href(a.name)} className={linkClassName}>{a.name}</Link>
        </span>
      ))}
    </>
  );
}
