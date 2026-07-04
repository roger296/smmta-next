/**
 * Config-key coverage (Prompt 16). Proves the root `.env.example` documents
 * every variable the app actually reads, so a self-hoster's env template is
 * never missing a key. A small allow-list covers infra/deploy-only keys.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENV_KEYS } from './env.js';

// Keys read by infra/scripts, not the app config module (documented elsewhere).
const ALLOWED_MISSING = new Set(['BACKUP_RCLONE_REMOTE', 'BACKUP_DIR', 'LOG_LEVEL']);

describe('.env.example coverage', () => {
  it('documents every environment key the app reads', () => {
    // vitest runs with cwd = apps/api.
    const envExample = readFileSync(resolve(process.cwd(), '../../.env.example'), 'utf8');
    const documented = new Set(
      envExample
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.split('=')[0]!.trim()),
    );

    const missing = ENV_KEYS.filter((k) => !documented.has(k) && !ALLOWED_MISSING.has(k));
    expect(missing, `Undocumented env keys in .env.example: ${missing.join(', ')}`).toEqual([]);
  });
});
