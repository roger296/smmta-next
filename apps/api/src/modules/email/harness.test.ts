/**
 * Section 0 harness check: the email tests can reach the test database, can
 * intercept outbound HTTP, and run under fake timers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { resetEnvForTests } from '../../config/env.js';
import { configuredSendMode, isAllowlisted } from './lib/config.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetEnvForTests();
});

describe('email test harness', () => {
  it('reaches the test database', async () => {
    const rows = await getDb().execute(sql`select 1 as one`);
    expect((rows as unknown as { rows: Array<{ one: number }> }).rows[0]?.one).toBe(1);
  });

  it('intercepts outbound HTTP', async () => {
    const fake = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fake);
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', { method: 'POST' });
    expect(await res.json()).toEqual({ ok: true });
    expect(fake).toHaveBeenCalledOnce();
  });

  it('controls time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T10:00:00Z'));
    expect(new Date().toISOString()).toBe('2026-11-05T10:00:00.000Z');
  });

  it('refuses an unknown send mode and leaves an unset one unset', () => {
    vi.stubEnv('EMAIL_SEND_MODE', 'production');
    resetEnvForTests();
    expect(() => configuredSendMode()).toThrow();
    vi.stubEnv('EMAIL_SEND_MODE', '');
    delete process.env.EMAIL_SEND_MODE;
    resetEnvForTests();
    expect(configuredSendMode()).toBeNull();
  });

  it('matches the test allowlist without regard to case', () => {
    vi.stubEnv('EMAIL_TEST_ALLOWLIST', 'Owner@Example.com, other@example.com');
    resetEnvForTests();
    expect(isAllowlisted('owner@example.com')).toBe(true);
    expect(isAllowlisted('stranger@example.com')).toBe(false);
  });
});
