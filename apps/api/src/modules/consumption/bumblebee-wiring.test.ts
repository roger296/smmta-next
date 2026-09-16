/**
 * Wiring up the BumbleBee session feed (Sept-2026).
 *
 * ── THE PROBLEM THIS GUARDS ─────────────────────────────────────────────────
 * Every way of getting this wrong produces the same symptom: zero sessions.
 * Not configured, wrong URL, expired key, a site name BumbleBee has never heard
 * of, a quiet Tuesday. The venue screen shows an empty picker for all of them.
 *
 * The wire format is pinned against the real service — verified 16 Sept 2026
 * against BumbleBee's own `/api/v1/sessions` and `/api/v1/orders`:
 *
 *   sessions → { rows: [{ id, site, session_type, start, …, capacity }],
 *                total_count, next_offset }
 *   orders   → { rows: [{ id, site, pax, session_id, event_date, … }],
 *                total_count, next_offset }
 *
 * `capacity` is what the room holds, NOT who booked — covers come from summing
 * orders' `pax`, and confusing the two would overstate every expectation.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase } from '../../config/database.js';
import { resetEnvForTests } from '../../config/env.js';
import { BumbleBeeSessionClient } from './bumblebee-sessions.js';
import { redactUrl } from '../../../scripts/check-bumblebee.js';

const BASE = 'https://bumblebee.example.invalid';
const SITE = 'London East';
const DATE = '2026-09-13';

/** A real session row, trimmed to the fields the client reads. */
const sessionRow = (id: string, start: string) => ({
  id,
  site: SITE,
  session_type: 'EVENT',
  start,
  end: '2026-09-13T12:00:00+00:00',
  capacity: 24,
});

const orderRow = (sessionId: string, pax: number) => ({
  id: `o-${sessionId}-${pax}`,
  site: SITE,
  pax,
  session_id: sessionId,
  event_date: DATE,
});

let calls: string[] = [];

/** Stand in for BumbleBee. `answer` maps a path to its body. */
function serve(answer: (path: string, url: URL) => { status?: number; body?: unknown }) {
  vi.stubGlobal('fetch', async (input: URL | string) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const { status = 200, body = { rows: [] } } = answer(url.pathname, url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

beforeEach(() => {
  calls = [];
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

afterAll(() => closeDatabase());

const listDay = () =>
  new BumbleBeeSessionClient().listSessionsForDay({ siteCanonicalName: SITE, date: DATE });

describe('the query it sends', () => {
  it('filters on date_from/date_to, not a `date` param', () => {
    // There is no `date` param. FastAPI ignores an unknown one, so sending it
    // would silently return EVERY session for the site — a picker offering
    // last March's sittings, with nothing erroring.
    serve(() => ({ body: { rows: [], total_count: 0 } }));
    return listDay().then(() => {
      expect(calls[0]).toContain(`date_from=${DATE}`);
      expect(calls[0]).toContain(`date_to=${DATE}`);
      expect(calls[0]).not.toMatch(/[?&]date=/);
    });
  });

  it('asks for EVENT sessions only', async () => {
    // CAFE_BAR is a synthetic all-day container for till takings — no leader,
    // no cake, nothing to file. It would park one permanently unfileable row
    // on every venue picker.
    serve(() => ({ body: { rows: [], total_count: 0 } }));
    await listDay();
    expect(calls[0]).toContain('session_type=EVENT');
  });

  it('sends the site canonical name BumbleBee expects', async () => {
    serve(() => ({ body: { rows: [], total_count: 0 } }));
    await listDay();
    expect(calls[0]).toContain('site=London+East');
  });
});

describe('the shape it reads back', () => {
  it('maps id → sessionId and start → startsAt', async () => {
    serve((path) =>
      path === '/api/v1/sessions'
        ? { body: { rows: [sessionRow('s-1', '2026-09-13T10:00:00+00:00')], total_count: 1 } }
        : { body: { rows: [], total_count: 0 } },
    );
    const [only] = await listDay();
    expect(only).toMatchObject({
      sessionId: 's-1',
      sessionDate: DATE,
      startsAt: '2026-09-13T10:00:00+00:00',
    });
  });

  it('takes covers from orders’ pax, NOT from the session capacity', async () => {
    // `capacity: 24` is what the room holds. Using it would tell a baker to
    // expect ingredients for 24 when 8 turned up.
    serve((path) =>
      path === '/api/v1/sessions'
        ? { body: { rows: [sessionRow('s-1', '2026-09-13T10:00:00+00:00')], total_count: 1 } }
        : { body: { rows: [orderRow('s-1', 6), orderRow('s-1', 2)], total_count: 2 } },
    );
    const [only] = await listDay();
    expect(only!.covers).toBe(8);
  });

  it('still lists the sessions when the covers lookup fails', async () => {
    // Knowing a sitting happened matters more than knowing how many attended.
    serve((path) =>
      path === '/api/v1/sessions'
        ? { body: { rows: [sessionRow('s-1', '2026-09-13T10:00:00+00:00')], total_count: 1 } }
        : { status: 500, body: {} },
    );
    const day = await listDay();
    expect(day).toHaveLength(1);
    expect(day[0]!.covers).toBe(0);
  });
});

describe('the failures that must NOT look like "no sessions"', () => {
  it('throws on a bad key, naming it', async () => {
    serve(() => ({ status: 401, body: {} }));
    await expect(listDay()).rejects.toThrow(/401.*BUMBLEBEE_API_KEY/);
  });

  it('throws when the server errors, rather than reporting an empty day', async () => {
    serve(() => ({ status: 503, body: {} }));
    await expect(listDay()).rejects.toThrow(/503/);
  });

  it('⚠️ throws when the page cap truncated the answer', async () => {
    // BumbleBee caps a page and reports the real size in `total_count`. Taking
    // `rows` without checking would undercount covers on a busy day — a
    // smaller expected consumption, a variance that looks like the baker's
    // fault, and a materials cost that is simply wrong, with nothing saying a
    // page was cut short.
    serve((path) =>
      path === '/api/v1/sessions'
        ? { body: { rows: [sessionRow('s-1', '2026-09-13T10:00:00+00:00')], total_count: 250 } }
        : { body: { rows: [], total_count: 0 } },
    );
    await expect(listDay()).rejects.toThrow(/1 of 250 rows.*page cap/s);
  });

  it('is silent when the counts agree', async () => {
    serve((path) =>
      path === '/api/v1/sessions'
        ? { body: { rows: [sessionRow('s-1', '2026-09-13T10:00:00+00:00')], total_count: 1 } }
        : { body: { rows: [], total_count: 0 } },
    );
    await expect(listDay()).resolves.toHaveLength(1);
  });

  it('sends the key as a bearer token', async () => {
    let auth: string | null = null;
    vi.stubGlobal('fetch', async (_input: URL | string, init?: RequestInit) => {
      auth = new Headers(init?.headers).get('authorization');
      return new Response(JSON.stringify({ rows: [], total_count: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await listDay();
    expect(auth).toBe('Bearer test-key');
  });
});

describe('redactUrl', () => {
  it('keeps the host so an operator can see WHICH BumbleBee', () => {
    expect(redactUrl('https://bumblebee.starship.example.com')).toBe(
      'https://bumblebee.starship.example.com',
    );
  });

  it('drops a query string, which could carry a key', () => {
    // The check script prints this. A token echoed into a deploy log is a
    // token in a deploy log.
    expect(redactUrl('https://bb.example.com/api?token=sekrit')).toBe('https://bb.example.com/api');
  });

  it('says so rather than printing nonsense', () => {
    expect(redactUrl('')).toBe('(not set)');
    expect(redactUrl('not a url')).toBe('(not a valid URL)');
  });
});
