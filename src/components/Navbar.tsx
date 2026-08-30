'use client';

// src/components/Navbar.tsx
import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useSession, signOut } from 'next-auth/react';
import { Search, Menu, X, Disc3, ShieldCheck, LogOut, Settings } from 'lucide-react';
import { clsx } from 'clsx';
import { Avatar } from './ui/Avatar';
import { Button } from './ui/Button';
import { TrustBadge } from './ui/TrustBadge';

const NAV_LINKS = [
  { href: '/entries', label: 'Database' },
  { href: '/submissions', label: 'Submissions' },
  { href: '/submit', label: 'Submit' },
  { href: '/search', label: 'Search' },
];

export function Navbar() {
  const { data: session, status } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-bg-base/80 backdrop-blur-md">
      {session?.user?.isBanned && (
        <div className="bg-status-rejected-bg border-b border-status-rejected/30 px-4 py-1.5 text-center text-xs text-status-rejected">
          Your account has been banned — you can browse, but submitting, verifying, and commenting are disabled.
        </div>
      )}
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2.5 shrink-0 group">
            <div className="relative w-8 h-8 rounded-lg bg-phosphor/10 border border-phosphor/30 flex items-center justify-center group-hover:shadow-phosphor-sm transition-shadow">
              <Disc3 size={18} className="text-phosphor" />
            </div>
            <span className="font-display font-bold text-text-primary tracking-tight hidden sm:block">
              Hack<span className="text-phosphor">Hash</span>
            </span>
          </Link>

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-1">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={clsx(
                  'px-3 py-2 rounded-md text-sm font-medium transition-colors',
                  pathname === link.href || pathname?.startsWith(link.href + '/')
                    ? 'text-phosphor bg-phosphor/10'
                    : 'text-text-secondary hover:text-text-primary hover:bg-bg-elevated'
                )}
              >
                {link.label}
              </Link>
            ))}
            {session?.user.role === 'ADMINISTRATOR' && (
              <Link
                href="/admin/submissions"
                className={clsx(
                  'flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                  pathname?.startsWith('/admin')
                    ? 'text-phosphor bg-phosphor/10'
                    : 'text-text-secondary hover:text-text-primary hover:bg-bg-elevated'
                )}
              >
                <ShieldCheck size={14} />
                Admin
              </Link>
            )}
          </nav>

          {/* Right side */}
          <div className="flex items-center gap-3">
            <Link
              href="/search"
              className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-md border border-border text-text-muted hover:text-text-primary hover:border-phosphor/40 transition-colors text-sm"
            >
              <Search size={14} />
              <span className="hidden lg:inline">Search hashes, names…</span>
            </Link>

            {status === 'loading' && (
              <div className="w-8 h-8 rounded-full bg-bg-elevated animate-pulse" />
            )}

            {status === 'unauthenticated' && (
              <Button size="sm" onClick={() => router.push(`/auth/signin?callbackUrl=${encodeURIComponent(pathname)}`)}>
                Sign in
              </Button>
            )}

            {status === 'authenticated' && session?.user && (
              <div className="flex items-center gap-1.5">
                <Link href={`/profile/${session.user.id}`} className="flex items-center gap-2 group">
                  <div className="hidden sm:flex flex-col items-end leading-tight">
                    <span className="text-xs font-medium text-text-primary group-hover:text-phosphor transition-colors">
                      {session.user.name}
                    </span>
                    <TrustBadge score={session.user.trustScore} />
                  </div>
                  <Avatar src={session.user.image} name={session.user.name} size={32} />
                </Link>
                <Link
                  href="/account"
                  title="Account settings"
                  className="p-1.5 rounded-md text-text-muted hover:text-phosphor hover:bg-phosphor/10 transition-colors hidden sm:flex"
                >
                  <Settings size={15} />
                </Link>
                <button
                  onClick={() => signOut()}
                  title="Sign out"
                  className="p-1.5 rounded-md text-text-muted hover:text-status-rejected hover:bg-status-rejected-bg transition-colors hidden sm:flex"
                >
                  <LogOut size={15} />
                </button>
              </div>
            )}

            <button
              className="md:hidden text-text-secondary"
              onClick={() => setMobileOpen((v) => !v)}
            >
              {mobileOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>

        {/* Mobile nav */}
        {mobileOpen && (
          <nav className="md:hidden flex flex-col gap-1 pb-4 animate-fade-in">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className={clsx(
                  'px-3 py-2.5 rounded-md text-sm font-medium transition-colors',
                  pathname === link.href ? 'text-phosphor bg-phosphor/10' : 'text-text-secondary hover:bg-bg-elevated'
                )}
              >
                {link.label}
              </Link>
            ))}
            {session?.user.role === 'ADMINISTRATOR' && (
              <Link href="/admin/submissions" onClick={() => setMobileOpen(false)} className="px-3 py-2.5 rounded-md text-sm font-medium text-text-secondary hover:bg-bg-elevated">
                Admin Dashboard
              </Link>
            )}
            {session && (
              <Link
                href="/account"
                onClick={() => setMobileOpen(false)}
                className="px-3 py-2.5 rounded-md text-sm font-medium text-text-secondary hover:bg-bg-elevated"
              >
                Account settings
              </Link>
            )}
            {session && (
              <button
                onClick={() => signOut()}
                className="px-3 py-2.5 rounded-md text-sm font-medium text-status-rejected hover:bg-status-rejected-bg text-left"
              >
                Sign out
              </button>
            )}
          </nav>
        )}
      </div>
    </header>
  );
}
