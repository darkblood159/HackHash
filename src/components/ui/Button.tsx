// src/components/ui/Button.tsx
import React from 'react';
import { clsx } from 'clsx';
import { Loader2 } from 'lucide-react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', loading, disabled, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={clsx(
          'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-all',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          {
            'bg-phosphor text-bg-base hover:bg-phosphor-bright shadow-phosphor-sm hover:shadow-phosphor': variant === 'primary',
            'bg-bg-elevated text-text-primary hover:bg-bg-hover border border-border': variant === 'secondary',
            'text-text-secondary hover:text-text-primary hover:bg-bg-elevated': variant === 'ghost',
            'bg-status-rejected/10 text-status-rejected border border-status-rejected/30 hover:bg-status-rejected/20': variant === 'danger',
            'border border-border text-text-primary hover:border-phosphor/50 hover:text-phosphor': variant === 'outline',
          },
          {
            'text-xs px-3 py-1.5': size === 'sm',
            'text-sm px-4 py-2': size === 'md',
            'text-base px-6 py-3': size === 'lg',
          },
          className
        )}
        {...props}
      >
        {loading && <Loader2 size={14} className="animate-spin" />}
        {children}
      </button>
    );
  }
);
Button.displayName = 'Button';
