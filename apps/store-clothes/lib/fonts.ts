/**
 * Clothes Shop fonts, self-hosted from files in this repository.
 *
 * Body: Inter (same family as the Filament Store — body type doesn't
 * need to be the differentiator).
 * Display: Fraunces — friendly serif with personality, the actual
 * brand differentiator.
 *
 * Both are the variable WOFF2s in `lib/fonts/` (latin subset, from the
 * fontsource builds of the SIL OFL releases; licences alongside), served by
 * next/font/local. `next/font/google` fetched them from Google on every
 * build, and a bad answer from Google failed the whole deploy.
 */
import localFont from 'next/font/local';

const interBody = localFont({
  src: [{ path: './fonts/inter-latin-wght-normal.woff2', weight: '100 900', style: 'normal' }],
  variable: '--font-body',
  display: 'swap',
  fallback: [
    'ui-sans-serif',
    'system-ui',
    '-apple-system',
    'BlinkMacSystemFont',
    'Segoe UI',
    'Roboto',
    'sans-serif',
  ],
});

const fraunces = localFont({
  src: [{ path: './fonts/fraunces-latin-wght-normal.woff2', weight: '100 900', style: 'normal' }],
  variable: '--font-display',
  display: 'swap',
  fallback: ['Georgia', 'Times New Roman', 'serif'],
});

export const fontClassName = `${interBody.variable} ${fraunces.variable}`.trim();
