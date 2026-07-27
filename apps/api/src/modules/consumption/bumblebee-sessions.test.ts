/**
 * These tests pin the wire contract of BumbleBee's `GET /api/v1/sessions`
 * (bakes-core `services/queries.py::query_sessions`).
 *
 * They exist because every way of getting it wrong fails *silently*: FastAPI
 * ignores an unknown `date` query param, and reading a missing `data` key just
 * yields []. Both produce "no bake sessions anywhere" on a working system.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvForTests } from '../../config/env.js';
import { BumbleBeeSessionClient } from './bumblebee-sessions.js';

const BASE = 'https://bumblebee.example.test';

function mockFetch(handler: (url: URL) => { status?: number; body?: unknown }) {
  return vi.fn(async (input: string | URL) => {
    const { status = 200, body = { rows: [] } } = handler(new URL(String(input)));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  });
}

const SESSION_ROWS = {
  rows: [
    { id: 'sess-1', site: 'Manchester', start: '2026-07-26T10:00:00+00:00' },
    { id: 'sess-2', site: 'Manchester', start: '2026-07-26T14:00:00+00:00' },
  ],
};

describe('BumbleBeeSessionClient', () => {
  beforeEach(() => {
    process.env.BUMBLEBEE_API_BASE_URL = BASE;
    process.env.BUMBLEBEE_API_KEY = 'test-key';
    resetEnvForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BUMBLEBEE_API_BASE_URL;
    delete process.env.BUMBLEBEE_API_KEY;
    resetEnvForTests();
  });

  it('returns [] without calling out when no base URL is set', async () => {
    delete process.env.BUMBLEBEE_API_BASE_URL;
    resetEnvForTests();
    const fetchMock = mockFetch(() => ({}));
    vi.stubGlobal('fetch', fetchMock);

    expect(
      await new BumbleBeeSessionClient().listSessionsForDay({
        siteCanonicalName: 'Manchester',
        date: '2026-07-26',
      }),
    ).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('filters by date_from/date_to — BumbleBee has no `date` param', async () => {
    const seen: URL[] = [];
    vi.stubGlobal(
      'fetch',
      mockFetch((url) => {
        seen.push(url);
        return { body: url.pathname.includes('sessions') ? SESSION_ROWS : { rows: [] } };
      }),
    );

    await new BumbleBeeSessionClient().listSessionsForDay({
      siteCanonicalName: 'Manchester',
      date: '2026-07-26',
    });

    const sessions = seen.find((u) => u.pathname === '/api/v1/sessions')!;
    expect(sessions.searchParams.get('date_from')).toBe('2026-07-26');
    expect(sessions.searchParams.get('date_to')).toBe('2026-07-26');
    expect(sessions.searchParams.get('site')).toBe('Manchester');
    // Sending `date` would be silently ignored and return every session ever.
    expect(sessions.searchParams.has('date')).toBe(false);
  });

  it('reads the `rows` key and maps `id`/`start`', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch((url) => ({
        body: url.pathname.includes('sessions') ? SESSION_ROWS : { rows: [] },
      })),
    );

    const out = await new BumbleBeeSessionClient().listSessionsForDay({
      siteCanonicalName: 'Manchester',
      date: '2026-07-26',
    });

    expect(out.map((s) => s.sessionId)).toEqual(['sess-1', 'sess-2']);
    // `start` is a full timestamp; the form and dashboard key off the date.
    expect(out[0].sessionDate).toBe('2026-07-26');
  });

  it('sums covers from order pax, per session', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch((url) =>
        url.pathname.includes('sessions')
          ? { body: SESSION_ROWS }
          : {
              body: {
                rows: [
                  { session_id: 'sess-1', pax: 8 },
                  { session_id: 'sess-1', pax: 4 },
                  { session_id: 'sess-2', pax: 6 },
                  { session_id: null, pax: 99 }, // unattached — must not count
                ],
              },
            },
      ),
    );

    const out = await new BumbleBeeSessionClient().listSessionsForDay({
      siteCanonicalName: 'Manchester',
      date: '2026-07-26',
    });

    expect(out.find((s) => s.sessionId === 'sess-1')?.covers).toBe(12);
    expect(out.find((s) => s.sessionId === 'sess-2')?.covers).toBe(6);
  });

  it('throws on 401 so a bad key cannot read as a quiet day', async () => {
    vi.stubGlobal('fetch', mockFetch(() => ({ status: 401 })));

    await expect(
      new BumbleBeeSessionClient().listSessionsForDay({
        siteCanonicalName: 'Manchester',
        date: '2026-07-26',
      }),
    ).rejects.toThrow(/BUMBLEBEE_API_KEY/);
  });

  it('still lists sessions when the covers lookup fails', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch((url) =>
        url.pathname.includes('sessions') ? { body: SESSION_ROWS } : { status: 500 },
      ),
    );

    const out = await new BumbleBeeSessionClient().listSessionsForDay({
      siteCanonicalName: 'Manchester',
      date: '2026-07-26',
    });

    expect(out).toHaveLength(2);
    expect(out.every((s) => s.covers === 0)).toBe(true);
  });
});
