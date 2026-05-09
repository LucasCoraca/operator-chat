/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        /* Accent — Pistachio */
        accent: {
          DEFAULT: 'oklch(0.82 0.16 145)',
          ink: '#0a1410',
          soft: 'color-mix(in oklch, oklch(0.82 0.16 145) 14%, transparent)',
          line: 'color-mix(in oklch, oklch(0.82 0.16 145) 28%, transparent)',
          glow: 'color-mix(in oklch, oklch(0.82 0.16 145) 38%, transparent)',
        },
        /* Status colors */
        amber: {
          DEFAULT: 'oklch(0.82 0.13 78)',
          soft: 'color-mix(in oklch, oklch(0.82 0.13 78) 12%, transparent)',
          line: 'color-mix(in oklch, oklch(0.82 0.13 78) 24%, transparent)',
        },
        rose: {
          DEFAULT: 'oklch(0.74 0.13 18)',
          soft: 'color-mix(in oklch, oklch(0.74 0.13 18) 12%, transparent)',
          line: 'color-mix(in oklch, oklch(0.74 0.13 18) 24%, transparent)',
        },
        blue: {
          DEFAULT: 'oklch(0.74 0.13 245)',
          soft: 'color-mix(in oklch, oklch(0.74 0.13 245) 12%, transparent)',
          line: 'color-mix(in oklch, oklch(0.74 0.13 245) 24%, transparent)',
        },
        violet: {
          DEFAULT: 'oklch(0.75 0.13 290)',
          soft: 'color-mix(in oklch, oklch(0.75 0.13 290) 12%, transparent)',
          line: 'color-mix(in oklch, oklch(0.75 0.13 290) 24%, transparent)',
        },
        /* Surfaces */
        surface: {
          0: '#0c0d0f',
          1: '#121316',
          2: '#181a1e',
          3: '#22252b',
          elev: '#1c1f24',
        },
        /* Foreground */
        fg: {
          0: '#ecedef',
          1: '#b8bbc1',
          2: '#7e828a',
          3: '#4f535b',
        },
        /* Legacy brand — kept for backward compat but no longer primary */
        brand: {
          DEFAULT: '#10a37f',
          dark: '#0d8c6d',
        },
      },
      fontFamily: {
        sans: ['Geist', 'Inter', 'system-ui', 'sans-serif'],
        serif: ['Instrument Serif', 'Georgia', 'Times New Roman', 'serif'],
        mono: ['Geist Mono', 'JetBrains Mono', 'Fira Code', 'SF Mono', 'Consolas', 'monospace'],
      },
      borderRadius: {
        DEFAULT: 'var(--radius, 12px)',
        sm: 'var(--radius-sm, 8px)',
        lg: 'var(--radius-lg, 14px)',
        pill: 'var(--radius-pill, 999px)',
        xs: 'var(--radius-xs, 6px)',
      },
      spacing: {
        '1.5': '6px',
        '2.5': '10px',
        '10': '40px',
        '14': '56px',
        '18': '72px',
      },
      boxShadow: {
        '1': '0 1px 0 rgba(255,255,255,.04) inset, 0 1px 2px rgba(0,0,0,.35)',
        '2': '0 1px 0 rgba(255,255,255,.04) inset, 0 8px 24px -10px rgba(0,0,0,.6), 0 2px 6px -2px rgba(0,0,0,.4)',
      },
      animation: {
        'pulse-dot': 'pulse-dot 1.6s ease-out infinite',
        'blink': 'blink 1s step-end infinite',
        'shimmer': 'shimmer 2s linear infinite',
        'fade-up': 'fade-up 0.3s ease',
        'slide-in': 'slide-in 0.22s ease',
      },
      transitionDuration: {
        '150': '150ms',
        '200': '200ms',
        '220': '220ms',
        '300': '300ms',
      },
      keyframes: {
        'pulse-dot': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '.5', transform: 'scale(.85)' },
        },
        'blink': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
        'shimmer': {
          '0%': { 'background-position': '-200% 0' },
          '100%': { 'background-position': '200% 0' },
        },
        'fade-up': {
          'from': { opacity: '0', transform: 'translateY(6px)' },
          'to': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in': {
          'from': { opacity: '0', transform: 'translateX(-8px)' },
          'to': { opacity: '1', transform: 'translateX(0)' },
        },
      },
      maxWidth: {
        'content': '820px',
      },
    },
  },
  plugins: [],
}
