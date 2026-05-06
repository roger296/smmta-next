/**
 * Self-hosted font wiring via next/font/google.
 *
 * Inter — the storefront's body + display family. `next/font/google`
 * downloads and self-hosts the WOFF2s at build time, so:
 *   - No external request at runtime (CSP `font-src` and `connect-src` stay clean)
 *   - Lighthouse performance unaffected (no third-party block)
 *   - Lighthouse SEO unaffected (no FOIT)
 *
 * Two CSS variables are exposed via the className applied to <html>:
 *   --font-display  → Inter at 600/700/800 for headings (`var(--font-display)`)
 *   --font-body     → Inter at 400/500 for body text (`var(--font-body)`)
 *
 * Both come from the same family so we get visual cohesion + a single woff2
 * payload covering all weights.
 *
 * If a more distinctive display face is wanted later (e.g. Söhne, Inter
 * Display, or a paid foundry release), this is the only file that needs
 * to change — `globals.css` and consumers reference the variables, not the
 * concrete family.
 */
import { Inter } from 'next/font/google';

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

const interDisplay = Inter({
  subsets: ['latin'],
  weight: ['600', '700', '800'],
  variable: '--font-display',
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

/**
 * className to apply to <html> (or any high-level wrapper). Setting it on
 * <html> lets every descendant resolve `var(--font-display)` / `var(--font-body)`
 * via the CSS variables that next/font injects.
 */
export const fontClassName = `${interBody.variable} ${interDisplay.variable}`.trim();
