import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        display: ['var(--font-space-grotesk)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-jetbrains-mono)', 'JetBrains Mono', 'monospace'],
      },
      colors: {
        // Dark purple-slate palette — a deliberate step away from pure black,
        // with a visible (not overwhelming) violet cast.
        bg: {
          base: '#161320',
          surface: '#1c1828',
          elevated: '#241f33',
          hover: '#2c2640',
        },
        border: {
          DEFAULT: '#332c47',
          focus: '#00d084',
          subtle: '#241f33',
        },
        phosphor: {
          DEFAULT: '#00d084',
          dim: '#00a066',
          bright: '#00f09a',
          glow: 'rgba(0, 208, 132, 0.15)',
        },
        text: {
          primary: '#e2e2f0',
          secondary: '#8a8aa8',
          muted: '#4a4a6a',
          inverse: '#0b0b0f',
        },
        status: {
          approved: '#22c55e',
          'approved-bg': 'rgba(34, 197, 94, 0.1)',
          pending: '#eab308',
          'pending-bg': 'rgba(234, 179, 8, 0.1)',
          rejected: '#ef4444',
          'rejected-bg': 'rgba(239, 68, 68, 0.1)',
          verified: '#60a5fa',
          'verified-bg': 'rgba(96, 165, 250, 0.1)',
          recommended: '#c084fc',
          'recommended-bg': 'rgba(192, 132, 252, 0.1)',
          disputed: '#f97316',
          'disputed-bg': 'rgba(249, 115, 22, 0.1)',
        },
      },
      boxShadow: {
        phosphor: '0 0 20px rgba(0, 208, 132, 0.2)',
        'phosphor-sm': '0 0 8px rgba(0, 208, 132, 0.15)',
        card: '0 1px 3px rgba(0, 0, 0, 0.5)',
        'card-hover': '0 4px 16px rgba(0, 0, 0, 0.6)',
      },
      keyframes: {
        'hash-reveal': {
          '0%': { opacity: '0', filter: 'blur(4px)' },
          '100%': { opacity: '1', filter: 'blur(0)' },
        },
        'scan': {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100%)' },
        },
        'pulse-phosphor': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' },
        },
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'hash-reveal': 'hash-reveal 0.3s ease-out forwards',
        'scan': 'scan 2s linear infinite',
        'pulse-phosphor': 'pulse-phosphor 1.5s ease-in-out infinite',
        'fade-in': 'fade-in 0.2s ease-out forwards',
      },
    },
  },
  plugins: [],
};

export default config;
