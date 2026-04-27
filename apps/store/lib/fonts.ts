/**
 * Self-hosted font wiring.
 *
 * v1 deliberately uses system stacks via CSS variables: the Filament Store's
 * brand fonts (display + body) haven't been finalised yet — that's a Prompt 4
 * launch-checklist item. When the WOFF2 files arrive, drop them under
 * `public/fonts/` and replace the constants below with `next/font/local`
 * loaders. The CSS-variable contract (`--font-display`, `--font-body`) is
 * already wired into `globals.css` and Tailwind's `@theme`, so no consumer
 * code needs to change.
 *
 * Sketch for when fonts land:
 *
 *     import localFont from 'next/font/local';
 *
 *     export const displayFont = localFont({
 *       src: [
 *         { path: '../public/fonts/brand-display-regular.woff2', weight: '400', style: 'normal' },
 *         { path: '../public/fonts/brand-display-bold.woff2', weight: '700', style: 'normal' },
 *       ],
 *       variable: '--font-display',
 *       display: 'swap',
 *     });
 *     export const bodyFont = localFont({ ... variable: '--font-body' });
 *
 * The CSS-variable-bound system stack used today still hits Lighthouse SEO
 * and Performance ≥ 95 because there is no font network request to wait on.
 */

const SYSTEM_DISPLAY_STACK =
  'ui-serif, "Iowan Old Style", Georgia, "Times New Roman", Times, serif';
const SYSTEM_BODY_STACK =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

/** Inline style that exposes both CSS variables on the <html> element. Until
 *  next/font/local is wired in this is a plain object with the system stacks. */
export const fontVariables: Record<string, string> = {
  '--font-display': SYSTEM_DISPLAY_STACK,
  '--font-body': SYSTEM_BODY_STACK,
};
