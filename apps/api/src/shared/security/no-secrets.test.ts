/**
 * Secret-pattern scan (P1).
 *
 * A simple guard that no high-signal credential has been committed into the
 * API source tree. It walks `apps/api/src`, reads text files, and fails if any
 * line matches a known secret shape (PEM private keys, AWS / Google / Stripe /
 * GitHub / Slack / Anthropic-OpenAI tokens). Patterns are deliberately
 * high-signal so the test stays free of false positives on dev defaults like
 * `dev-secret-change-in-production` or the `smmta:smmta` local DB URL.
 *
 * The scanner skips its own file (the regex literals below would otherwise
 * match themselves).
 */
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const SELF = 'no-secrets.test.ts';
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.env', '.sql']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'coverage', '.turbo']);

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'PEM private key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Stripe live secret', re: /\bsk_live_[0-9A-Za-z]{16,}/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[0-9A-Za-z]{36,}/ },
  { name: 'Slack token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/ },
  { name: 'Anthropic key', re: /\bsk-ant-[0-9A-Za-z_-]{20,}/ },
  { name: 'OpenAI-style key', re: /\bsk-[0-9A-Za-z]{40,}\b/ },
];

async function collectFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await collectFiles(full)));
    } else if (entry.name !== SELF && TEXT_EXT.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

describe('no committed secrets', () => {
  it('finds no high-signal secret patterns in apps/api/src', async () => {
    const files = await collectFiles(SRC_ROOT);
    const violations: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        for (const { name, re } of SECRET_PATTERNS) {
          if (re.test(line)) {
            violations.push(`${path.relative(SRC_ROOT, file)}:${i + 1} — ${name}`);
          }
        }
      });
    }
    expect(violations, `Possible committed secrets:\n${violations.join('\n')}`).toEqual([]);
  });
});
