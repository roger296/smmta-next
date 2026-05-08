/**
 * Clothes Shop fonts.
 *
 * Body: Inter (same family as the Filament Store — body type doesn't
 * need to be the differentiator).
 * Display: Fraunces — friendly serif with personality, the actual
 * brand differentiator. Italic available for accent quotes.
 *
 * Self-hosted via next/font/google.
 */
import { Fraunces, Inter } from 'next/font/google';

const interBody = Inter({
  subsets: ['latin'],
  weight: ['400', '500'],
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

const fraunces = Fraunces({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-display',
  display: 'swap',
  fallback: ['Georgia', 'Times New Roman', 'serif'],
});

export const fontClassName = `${interBody.variable} ${fraunces.variable}`.trim();
