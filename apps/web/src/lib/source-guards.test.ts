/**
 * Guards for whole CLASSES of the 12 Aug defects (Aug-2026 feedback set, F15).
 *
 * Each of these is a property of the source tree rather than of any one
 * component — the kind of thing that was true on 11 August, quietly stopped
 * being true, and was only noticed by a venue with a delivery on the counter.
 * A unit test cannot catch "nobody calls this function"; a grep can.
 *
 * `pageSize` has its own file (`page-size-guard.test.ts`, defect D-1).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bucketCount } from './uom';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}

const isTest = (file: string) => /\.test\.(ts|tsx)$/.test(file);
const rel = (file: string) => path.relative(SRC, file);

/**
 * Comments describe the defects these guards are for, quoting the very code
 * that caused them. Scanning them would fail on every fix's own explanation —
 * so the guards read the code, not the prose about it.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');
}

describe('A-2: flushPwaQueue has a production call site', () => {
  /**
   * "Queued work never reached the server." The replayer existed, was
   * exported, was unit-tested — and was called from nowhere in the app. Work
   * captured offline sat in localStorage for ever.
   */
  it('is called from at least one non-test file that is not its own module', () => {
    const callers: string[] = [];
    for (const file of walk(SRC)) {
      if (isTest(file)) continue;
      if (rel(file) === path.join('lib', 'offline-queue.ts')) continue;
      const text = stripComments(readFileSync(file, 'utf8'));
      // A call, not merely an import or a re-export.
      if (/\bflushPwaQueue\s*\(/.test(text)) callers.push(rel(file));
    }
    expect(
      callers,
      'flushPwaQueue is exported but never called — defect A-2 exactly',
    ).not.toEqual([]);
  });

  it('one of those call sites is mounted at the app root', () => {
    const app = readFileSync(path.join(SRC, 'App.tsx'), 'utf8');
    expect(app).toMatch(/<PwaQueueSync\s*\/>/);
  });
});

describe('A-1: every venue submission is inside a try/catch', () => {
  /**
   * "Submissions reported as 'Saved offline — will sync' even when the server
   * rejected them." An unguarded `mutateAsync` rejects, React logs it, and the
   * screen carries on as though the work had landed.
   */
  it('no bare `await …mutateAsync(` in routes/_touch', () => {
    const offenders: string[] = [];
    let scanned = 0;
    const touch = path.join(SRC, 'routes', '_touch');
    for (const file of walk(touch)) {
      if (isTest(file)) continue;
      const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        if (!/\bmutateAsync\s*\(/.test(line)) return;
        scanned += 1;
        // Look back for the enclosing `try {`, forward for the `catch`. The
        // submit helpers all follow the same shape: `try { x = await …` /
        // `} catch (err) {`. A window of 40 lines covers every one of them.
        const before = lines.slice(Math.max(0, i - 12), i).join('\n');
        const after = lines.slice(i, Math.min(lines.length, i + 40)).join('\n');
        const guarded = /\btry\s*\{/.test(before) && /\}\s*catch\b/.test(after);
        if (!guarded) offenders.push(`${rel(file)}:${i + 1}`);
      });
    }
    // A guard that finds nothing to guard is not a guard. Every venue screen
    // submits something, so zero here means the scan itself has broken.
    expect(scanned, 'no mutateAsync found at all — the scan is not working').toBeGreaterThan(2);
    expect(
      offenders,
      'an unguarded mutateAsync leaves the screen claiming work was saved when it was refused',
    ).toEqual([]);
  });
});

describe('D-2: no count path applies a quantum unless one is configured', () => {
  /**
   * "Counts silently rounded to the nearest 100 stock units (4 kg → 0)."
   * `bucketCount` carried a blanket `quantum = 100` default. The fix was to
   * remove the default outright: an unconfigured product rounds to nothing.
   */
  it('bucketCount is the identity when no quantum is given', () => {
    expect(bucketCount(4000, 'g')).toBe(4000);
    expect(bucketCount(250, 'g', null)).toBe(250);
    expect(bucketCount(250, 'g', undefined)).toBe(250);
    // Zero is not a quantum — it is a missing one (see the importer's
    // `quantum-positive` rule).
    expect(bucketCount(250, 'g', 0)).toBe(250);
  });

  it('rounds only when a positive quantum is configured, and never a discrete unit', () => {
    expect(bucketCount(250, 'g', 100)).toBe(300);
    expect(bucketCount(7, 'each', 5)).toBe(7);
  });

  it('no caller supplies a default quantum of its own', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (isTest(file)) continue;
      const text = stripComments(readFileSync(file, 'utf8'));
      // `bucketCount(x, uom, 100)` or `quantum = 100` — a literal default
      // reintroduces D-2 one call site at a time.
      if (/quantum\s*(\?\?|=)\s*\d/.test(text)) offenders.push(rel(file));
    }
    expect(offenders, 'a defaulted quantum silently destroys counts (D-2)').toEqual([]);
  });
});

describe('B-4: the touch layer stays out of the desktop shell', () => {
  /**
   * "Venue screens were drawn over an admin page nobody could see."
   * `.touch-app` is a fixed full-screen overlay; under `_authed` it painted on
   * top of a sidebar-and-header layout that still scrolled underneath.
   */
  it('no /pwa or pin-login route lives under _authed', () => {
    const authed = path.join(SRC, 'routes', '_authed');
    const offenders: string[] = [];
    for (const file of walk(authed)) {
      const name = rel(file);
      if (/pwa|pin-login/.test(name)) offenders.push(name);
    }
    expect(offenders, 'venue screens belong under _touch, not the admin shell').toEqual([]);
  });

  it('the venue screens are all under _touch', () => {
    const touch = path.join(SRC, 'routes', '_touch', 'pwa');
    const screens = readdirSync(touch)
      .filter((f) => /\.tsx$/.test(f) && !/\.test\./.test(f))
      .sort();
    expect(screens).toEqual(['consumption.tsx', 'goods-in.tsx', 'stock-take.tsx']);
  });
});

describe('B-2: nothing opens the iOS keyboard on load', () => {
  /** "Keyboard opened on load and pushed the page up." */
  it('no autoFocus in the venue screens', () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(SRC, 'routes', '_touch'))) {
      if (isTest(file)) continue;
      if (/autoFocus/.test(stripComments(readFileSync(file, 'utf8')))) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });
});
