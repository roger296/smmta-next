/**
 * Font wiring, self-hosted from files in this repository.
 *
 * Inter — the storefront's body + display family. The variable WOFF2 in
 * `lib/fonts/` (latin subset, weights 100–900, from the fontsource build of
 * the SIL OFL release; licence alongside it) is served by next/font/local, so:
 *   - Nothing is fetched at build time. `next/font/google` downloaded the
 *     files from Google on every build, and a bad answer from Google failed
 *     the whole deploy: with two storefronts building at once that happened
 *     often enough to matter.
 *   - No external request at runtime (CSP `font-src` and `connect-src` stay clean)
 *   - Lighthouse performance unaffected (no third-party block)
 *   - Lighthouse SEO unaffected (no FOIT)
 *
 * Two CSS variables are exposed via the className applied to <html>:
 *   --font-display  → Inter for headings (`var(--font-display)`)
 *   --font-body     → Inter for body text (`var(--font-body)`)
 *
 * Both come from the same variable file, so every weight is one payload.
 *
 * If a more distinctive display face is wanted later (e.g. Söhne, Inter
 * Display, or a paid foundry release), this is the only file that needs
 * to change — `globals.css` and consumers reference the variables, not the
 * concrete family.
 */
import localFont from 'next/font/local';

// next/font reads these calls at build time and needs every value written
// out as a literal, so the fallback list is repeated rather than shared.
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

const interDisplay = localFont({
  src: [{ path: './fonts/inter-latin-wght-normal.woff2', weight: '100 900', style: 'normal' }],
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
