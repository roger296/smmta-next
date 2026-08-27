/**
 * Config-key coverage (Prompt 16). Proves the root `.env.example` documents
 * every variable the app actually reads, so a self-hoster's env template is
 * never missing a key. A small allow-list covers infra/deploy-only keys.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENV_KEYS, getEnv, resetEnvForTests } from './env.js';

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

describe('envBool', () => {
  const keys = ['LUCA_ENABLED', 'SENDGRID_SANDBOX', 'SENTRY_ENABLED'] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => keys.forEach((k) => (saved[k] = process.env[k])));
  afterEach(() => {
    keys.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
    resetEnvForTests();
  });

  // zod's coercing boolean uses Boolean(), for which 'false' is true — so
  // SENDGRID_SANDBOX=false kept email sandboxed and LUCA_ENABLED=false kept
  // Luca on. Every falsey spelling an operator might reasonably type must read
  // as false.
  it.each(['false', 'FALSE', '0', 'no', 'off', ' False '])('reads %j as false', (v) => {
    process.env.SENDGRID_SANDBOX = v;
    process.env.LUCA_ENABLED = v;
    resetEnvForTests();
    expect(getEnv().SENDGRID_SANDBOX).toBe(false);
    expect(getEnv().LUCA_ENABLED).toBe(false);
  });

  it.each(['true', 'TRUE', '1', 'yes', 'on'])('reads %j as true', (v) => {
    process.env.LUCA_ENABLED = v;
    resetEnvForTests();
    expect(getEnv().LUCA_ENABLED).toBe(true);
  });

  it('falls back to the default when unset or unrecognised', () => {
    delete process.env.LUCA_ENABLED;
    resetEnvForTests();
    expect(getEnv().LUCA_ENABLED).toBe(false);
    process.env.SENDGRID_SANDBOX = 'banana';
    resetEnvForTests();
    expect(getEnv().SENDGRID_SANDBOX).toBe(true); // default is true
  });
});
