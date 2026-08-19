/**
 * Colour contrast on the venue-name controls (Aug-2026 feedback, B-5 / B-6).
 *
 * B-6: the desktop header's site switcher sets `bg-[var(--color-background)]`
 * (near-white) but sat in the navy header, so it inherited
 * `--color-shell-foreground` — a pale grey chosen for a DARK ground. Pale grey
 * on near-white is roughly 1.6:1: the control that says where stock is being
 * booked was effectively unreadable.
 *
 * These are computed from the tokens themselves, so a future palette change
 * that reintroduces the problem fails here rather than at a venue.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readToken(css: string, name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(css);
  if (!match) throw new Error(`token ${name} not found`);
  return match[1]!.trim();
}

/** `hsl(H S% L%)` → sRGB 0..1 triple. */
function hslToRgb(value: string): [number, number, number] {
  const m = /hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/.exec(value);
  if (!m) throw new Error(`not an hsl() value: ${value}`);
  const h = Number(m[1]) / 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA for normal-size text. */
const AA_NORMAL = 4.5;

describe('B-6: the desktop site switcher is readable', () => {
  const css = readFileSync(path.join(ROOT, 'globals.css'), 'utf8');

  it('the pair the switcher actually renders passes WCAG AA', () => {
    // The trigger's own background, and the foreground the component now sets
    // explicitly rather than inheriting from the navy header.
    const background = hslToRgb(readToken(css, '--color-background'));
    const foreground = hslToRgb(readToken(css, '--color-foreground'));
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('documents WHY the inherited pair was unreadable', () => {
    // The regression this guards: shell-foreground is for a dark ground, and
    // fails badly on the trigger's near-white background.
    const background = hslToRgb(readToken(css, '--color-background'));
    const inherited = hslToRgb(readToken(css, '--color-shell-foreground'));
    expect(contrastRatio(inherited, background)).toBeLessThan(AA_NORMAL);
  });

  it('the site switcher sets its foreground explicitly', () => {
    const source = readFileSync(path.join(ROOT, 'components/layout/site-switcher.tsx'), 'utf8');
    expect(source).toContain('text-[var(--color-foreground)]');
  });
});

describe('B-5: the venue chip is readable on a venue screen', () => {
  const touchCss = readFileSync(path.join(ROOT, 'components/touch/pwa-touch.css'), 'utf8');

  it('white on the venue accent passes WCAG AA', () => {
    const chipGround = hexToRgb(readToken(touchCss, '--bar-venue'));
    expect(contrastRatio(hexToRgb('#ffffff'), chipGround)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('the warn variant is readable too — the "not set for this device" state', () => {
    const warnGround = hexToRgb(readToken(touchCss, '--bar-venue-warn'));
    expect(contrastRatio(hexToRgb('#ffffff'), warnGround)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('and it is NOT the badge amber, which fails on white', () => {
    // The reason `--bar-venue-warn` exists: `--warn` is tuned for dark text on
    // a pale badge, and white on it is ~3.7:1. Reusing it here would have
    // reintroduced B-6's failure mode on the chip that names the venue.
    const badgeAmber = hexToRgb(readToken(touchCss, '--warn'));
    expect(contrastRatio(hexToRgb('#ffffff'), badgeAmber)).toBeLessThan(AA_NORMAL);
  });
});
