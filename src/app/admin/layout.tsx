// src/app/admin/layout.tsx
import React from 'react';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ShieldCheck, Users, Inbox, UploadCloud, Pencil, Globe, Layers, Disc3 } from 'lucide-react';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);

  if (!session?.user || session.user.role !== 'ADMINISTRATOR') {
    redirect('/');
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12">
      <div className="flex items-center gap-2 mb-8">
        <ShieldCheck size={18} className="text-phosphor" />
        <h1 className="font-display text-2xl font-bold">Admin dashboard</h1>
      </div>

      <div className="flex gap-1 mb-8 border-b border-border">
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
        <Link href="/admin/hasheous" className="px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-phosphor flex items-center gap-1.5 border-b-2 border-transparent hover:border-phosphor/50 transition-colors">
          <Globe size={14} /> Hasheous
        </Link>
        <Link href="/admin/users" className="px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-phosphor flex items-center gap-1.5 border-b-2 border-transparent hover:border-phosphor/50 transition-colors">
          <Users size={14} /> Users
        </Link>
      </div>

      {children}
    </div>
  );
}
