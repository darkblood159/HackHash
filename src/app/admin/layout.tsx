// src/app/admin/layout.tsx
import React from 'react';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ShieldCheck, Users, Inbox, UploadCloud, Pencil, Globe, Layers, Disc3, Package, Settings } from 'lucide-react';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);

  if (!session?.user || session.user.role !== 'ADMINISTRATOR') {
    redirect('/');
  }

  // Only fetched for the one nav item that actually needs a live count —
  // see this file's own history for why the others don't have one: this
  // layout was, until now, a plain count-free server component, and adding
  // a count to every tab (submissions/change-requests/base-roms too) would
  // be a materially bigger, unrelated change to a nav bar that's worked
  // fine without them so far. This is the one that had NO discovery
  // surface at all before today — a pending item here was previously only
  // visible by opening the exact submission it was added to.
  const pendingFormatsCount = await prisma.alternateFormat.count({
    where: { status: 'PENDING', submission: { deletedAt: null } },
  });

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12">
      <div className="flex items-center gap-2 mb-8">
        <ShieldCheck size={18} className="text-phosphor" />
        <h1 className="font-display text-2xl font-bold">Admin dashboard</h1>
      </div>

      <div className="flex gap-1 mb-8 border-b border-border flex-wrap">
        <Link href="/admin/submissions?status=PENDING" className="px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-phosphor flex items-center gap-1.5 border-b-2 border-transparent hover:border-phosphor/50 transition-colors">
          <Inbox size={14} /> Submissions
        </Link>
        <Link href="/admin/import" className="px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-phosphor flex items-center gap-1.5 border-b-2 border-transparent hover:border-phosphor/50 transition-colors">
          <UploadCloud size={14} /> Import DAT
        </Link>
        <Link href="/admin/change-requests" className="px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-phosphor flex items-center gap-1.5 border-b-2 border-transparent hover:border-phosphor/50 transition-colors">
          <Pencil size={14} /> Change requests
        </Link>
        <Link href="/admin/hack-families" className="px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-phosphor flex items-center gap-1.5 border-b-2 border-transparent hover:border-phosphor/50 transition-colors">
          <Layers size={14} /> Hack families
        </Link>
        <Link href="/admin/base-roms" className="px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-phosphor flex items-center gap-1.5 border-b-2 border-transparent hover:border-phosphor/50 transition-colors">
          <Disc3 size={14} /> Base ROMs
        </Link>
        <Link href="/admin/alternate-formats" className="px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-phosphor flex items-center gap-1.5 border-b-2 border-transparent hover:border-phosphor/50 transition-colors">
          <Package size={14} /> Alternate formats
          {pendingFormatsCount > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-phosphor/20 text-phosphor text-[10px] font-bold">{pendingFormatsCount}</span>
          )}
        </Link>
        <Link href="/admin/hasheous" className="px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-phosphor flex items-center gap-1.5 border-b-2 border-transparent hover:border-phosphor/50 transition-colors">
          <Globe size={14} /> Hasheous
        </Link>
        <Link href="/admin/users" className="px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-phosphor flex items-center gap-1.5 border-b-2 border-transparent hover:border-phosphor/50 transition-colors">
          <Users size={14} /> Users
        </Link>
        <Link href="/admin/settings" className="px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-phosphor flex items-center gap-1.5 border-b-2 border-transparent hover:border-phosphor/50 transition-colors">
          <Settings size={14} /> Settings
        </Link>
      </div>

      {children}
    </div>
  );
}
