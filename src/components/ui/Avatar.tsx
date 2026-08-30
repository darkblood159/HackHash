// src/components/ui/Avatar.tsx
import React from 'react';
import Image from 'next/image';
import { clsx } from 'clsx';

interface AvatarProps {
  src?: string | null;
  name?: string | null;
  size?: number;
  className?: string;
}

export function Avatar({ src, name, size = 32, className }: AvatarProps) {
  const initials = (name ?? '?')
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  if (src) {
    return (
      <Image
        src={src}
        alt={name ?? 'User avatar'}
        width={size}
        height={size}
        className={clsx('rounded-full object-cover border border-border', className)}
      />
    );
  }

  return (
    <div
      style={{ width: size, height: size, fontSize: size * 0.38 }}
      className={clsx(
        'rounded-full bg-bg-elevated border border-border flex items-center justify-center',
        'font-display font-semibold text-phosphor shrink-0',
        className
      )}
    >
      {initials}
    </div>
  );
}
