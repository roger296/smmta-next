/**
 * Smooth Parcel client against a stubbed fetch: the login and token reuse, the
 * single retry on an expired token, and every label reply shape we accept.
 * No live HTTP.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SmoothParcelApiError,
  SmoothParcelClient,
  SmoothParcelUnreadableOrderError,
  type SmoothParcelClientOptions,
} from './smooth-parcel-client.js';
import type { SmoothParcelOrderPayload } from '../../modules/shipping/smooth-parcel-mapper.js';

const BASE = 'https://api-beta.smoothparcel.example';
const USERNAME = 'labels@example.invalid';
const PASSWORD = 'correct-horse-battery';
const PDF = Buffer.from('%PDF-1.4\n% label\n');
const payload = { TransactionID: 'STORE-1' } as unknown as SmoothParcelOrderPayload;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Replies in order; the last one repeats. */
function stubFetch(...replies: Array<() => Response>): Call[] {
  const calls: Call[] = [];
  let i = 0;
  globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return replies[Math.min(i++, replies.length - 1)]!();
  }) as unknown as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const loginOk = (token = 'jwt-1') => json({ EmailAddress: USERNAME, token });
const pdf = () => () =>
  new Response(new Uint8Array(PDF), { status: 200, headers: { 'Content-Type': 'application/pdf' } });

const client = (over: SmoothParcelClientOptions = {}) =>
  new SmoothParcelClient({ baseUrl: BASE, timeoutMs: 5000, username: USERNAME, password: PASSWORD, ...over });

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe('login', () => {
  it('logs in with the account email and password, then sends the token as a bearer', async () => {
    const calls = stubFetch(loginOk('jwt-1'), json({ OrderCode: 555001 }));
    await client().addNewOrder(payload);
    expect(calls[0]).toMatchObject({
      url: `${BASE}/api/users/authenticate`,
      method: 'POST',
      body: { EmailAddress: USERNAME, password: PASSWORD },
    });
    expect(calls[0]!.headers.Authorization).toBeUndefined();
    expect(calls[1]).toMatchObject({ url: `${BASE}/api/APIAccess/AddNewOrder`, method: 'POST', body: payload });
    expect(calls[1]!.headers.Authorization).toBe('Bearer jwt-1');
  });

  it('logs in once for a shipment and its label', async () => {
    const calls = stubFetch(loginOk(), json({ OrderCode: 555001 }), pdf());
    const c = client();
    const { orderCode } = await c.addNewOrder(payload);
    await c.getShipmentLabel(orderCode);
    expect(calls.map((x) => new URL(x.url).pathname)).toEqual([
      '/api/users/authenticate',
      '/api/APIAccess/AddNewOrder',
      '/api/APIAccess/GetShipmentLabel',
    ]);
  });

  it('logs in again, once, when the token has expired', async () => {
    const calls = stubFetch(loginOk('old'), json({}, 401), loginOk('new'), json({ OrderCode: 7 }));
    expect((await client().addNewOrder(payload)).orderCode).toBe('7');
    expect(calls).toHaveLength(4);
    expect(calls[3]!.headers.Authorization).toBe('Bearer new');
  });

  it('reports a rejected login without echoing the password', async () => {
    stubFetch(json({ message: `wrong password ${PASSWORD}` }, 400));
    const err = await client().addNewOrder(payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmoothParcelApiError);
    expect((err as Error).message).toMatch(/login was rejected \(400\)/);
    expect((err as Error).message).not.toContain(PASSWORD);
  });

  it('treats a 200 reply with status false as a rejected login', async () => {
    // How Smooth Parcel actually answers a wrong password.
    stubFetch(json({ status: false, message: 'Username or password is incorrect' }));
    await expect(client().addNewOrder(payload)).rejects.toThrow(
      /login was rejected: Username or password is incorrect/,
    );
  });

  it('makes no request at all without credentials', async () => {
    const calls = stubFetch(loginOk());
    await expect(client({ password: '' }).addNewOrder(payload)).rejects.toThrow(/username and password are not set/);
    expect(calls).toHaveLength(0);
  });
});

describe('addNewOrder', () => {
  it('reads the order code and tracking number from the reply', async () => {
    stubFetch(loginOk(), json({ OrderCode: 555001, SmoothParcelTrackingNumber: 'A1B2-C3D4' }));
    expect(await client().addNewOrder(payload)).toMatchObject({ orderCode: '555001', trackingNumber: 'A1B2-C3D4' });
  });

  it('accepts a reply that is only the order code', async () => {
    stubFetch(loginOk(), json(555001));
    expect((await client().addNewOrder(payload)).orderCode).toBe('555001');
  });

  it('flags a success reply with no order code as unreadable, keeping the reply', async () => {
    stubFetch(loginOk(), json({ Success: true, Message: 'Saved' }));
    const err = await client().addNewOrder(payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmoothParcelUnreadableOrderError);
    expect((err as SmoothParcelUnreadableOrderError).body).toEqual({ Success: true, Message: 'Saved' });
  });
});

describe('getShipmentLabel', () => {
  it('returns a PDF reply as it is, sending the order code as a number', async () => {
    const calls = stubFetch(loginOk(), pdf());
    expect((await client().getShipmentLabel('555001')).equals(PDF)).toBe(true);
    expect(calls[1]!.body).toEqual({ OrderCode: 555001 });
  });

  it('decodes a label sent as base64', async () => {
    stubFetch(loginOk(), json({ Label: PDF.toString('base64') }));
    expect((await client().getShipmentLabel('1')).equals(PDF)).toBe(true);
  });

  it('fetches a label sent as a path, from the API host, with the token', async () => {
    const calls = stubFetch(loginOk('jwt-1'), json({ LabelPath: 'Labels\\555001.pdf' }), pdf());
    expect((await client().getShipmentLabel('555001')).equals(PDF)).toBe(true);
    expect(calls[2]).toMatchObject({ url: `${BASE}/Labels/555001.pdf`, method: 'GET' });
    expect(calls[2]!.headers.Authorization).toBe('Bearer jwt-1');
  });

  it('refuses to fetch a label from any other host', async () => {
    const calls = stubFetch(loginOk(), json({ url: 'https://elsewhere.example/label.pdf' }));
    await expect(client().getShipmentLabel('1')).rejects.toThrow(/another host/);
    expect(calls).toHaveLength(2);
  });

  it('rejects a reply that is not a label', async () => {
    stubFetch(loginOk(), () => new Response('<html>error</html>', { status: 200 }));
    await expect(client().getShipmentLabel('1')).rejects.toThrow(/something other than a label PDF/);
  });
});

describe('checkConnection', () => {
  it('logs in and makes a tracking lookup, creating nothing', async () => {
    const calls = stubFetch(loginOk(), json({ message: 'not found' }, 404));
    expect(await client().checkConnection()).toEqual({ apiStatus: 404 });
    expect(calls.map((x) => new URL(x.url).pathname)).toEqual(['/api/users/authenticate', '/api/APIAccess/Tracking']);
  });

  it('fails when the API does not accept the token', async () => {
    stubFetch(loginOk(), json({}, 401));
    await expect(client().checkConnection()).rejects.toThrow(/refused API access/);
  });
});
