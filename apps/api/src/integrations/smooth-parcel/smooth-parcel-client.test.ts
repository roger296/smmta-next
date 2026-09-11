/**
 * Smooth Parcel client against a stubbed fetch: the API key header, the reply
 * wrapper the ETS integration documented, every label reply shape we accept,
 * and account registration. No live HTTP.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SmoothParcelApiError,
  SmoothParcelClient,
  SmoothParcelUnreadableOrderError,
  courierNameFrom,
  generateApiAccessKey,
  shippingServiceFrom,
  type SmoothParcelClientOptions,
} from './smooth-parcel-client.js';
import type { SmoothParcelOrderPayload } from '../../modules/shipping/smooth-parcel-mapper.js';

const BASE = 'https://api.smoothparcel.com';
const KEY = 'k3yK3yK3yK3yK3yK3yK3yA';
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
const pdf = () => () =>
  new Response(new Uint8Array(PDF), { status: 200, headers: { 'Content-Type': 'application/pdf' } });
const status = (code: number) => () => new Response('', { status: code });

const client = (over: SmoothParcelClientOptions = {}) =>
  new SmoothParcelClient({ baseUrl: BASE, timeoutMs: 5000, apiKey: KEY, ...over });

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe('authentication', () => {
  it('sends the API key as the raw Authorization header, with no login', async () => {
    const calls = stubFetch(json({ IsSuccess: true, ShipmentCode: 555001 }));
    await client().addNewOrder(payload);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `${BASE}/api/APIAccess/AddNewOrder`, method: 'POST', body: payload });
    expect(calls[0]!.headers.Authorization).toBe(KEY);
  });

  it('makes no request without a key', async () => {
    const calls = stubFetch(json({}));
    await expect(client({ apiKey: '' }).addNewOrder(payload)).rejects.toThrow(/API key is not set/);
    expect(calls).toHaveLength(0);
  });

  it('reports a refused key clearly', async () => {
    stubFetch(status(401));
    await expect(client().addNewOrder(payload)).rejects.toThrow(/refused the API key \(401\)/);
  });
});

describe('addNewOrder', () => {
  it('reads the shipment code, tracking number and label from the wrapper', async () => {
    stubFetch(
      json({
        IsSuccess: true,
        Message: 'Label generated',
        OrderCode: 0,
        ShipmentCode: 555001,
        TrackingNumber: 'A1B2-C3D4',
        shipmentLabelList: [{ FilePath: 'Labels/555001.pdf', TrackNumber: 'A1B2-C3D4' }],
      }),
    );
    expect(await client().addNewOrder(payload)).toMatchObject({
      orderCode: '555001',
      trackingNumber: 'A1B2-C3D4',
      labelPath: 'Labels/555001.pdf',
    });
  });

  it('reads the same wrapper in camelCase', async () => {
    stubFetch(json({ isSuccess: true, shipmentCode: 7, smoothTrackingNo: 'Z9Y8-X7W6', path: 'https://api.smoothparcel.com/Labels/7.pdf' }));
    expect(await client().addNewOrder(payload)).toMatchObject({
      orderCode: '7',
      trackingNumber: 'Z9Y8-X7W6',
      labelPath: 'https://api.smoothparcel.com/Labels/7.pdf',
    });
  });

  it('accepts a reply that is only the code', async () => {
    stubFetch(json(555001));
    expect((await client().addNewOrder(payload)).orderCode).toBe('555001');
  });

  it('treats IsSuccess false with no code as a plain refusal, not an unreadable reply', async () => {
    stubFetch(json({ IsSuccess: false, Message: 'Invalid postcode', OrderCode: 0 }));
    const err = await client().addNewOrder(payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmoothParcelApiError);
    expect(err).not.toBeInstanceOf(SmoothParcelUnreadableOrderError);
    expect((err as Error).message).toMatch(/refused the shipment: Invalid postcode/);
  });

  it('flags a reply that is neither a refusal nor readable', async () => {
    stubFetch(json({ Saved: true }));
    const err = await client().addNewOrder(payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmoothParcelUnreadableOrderError);
    expect((err as SmoothParcelUnreadableOrderError).body).toEqual({ Saved: true });
  });
});

describe('getShipmentLabel', () => {
  it('returns a PDF reply as it is, sending the order code as a number', async () => {
    const calls = stubFetch(pdf());
    expect((await client().getShipmentLabel('555001')).equals(PDF)).toBe(true);
    expect(calls[0]!.body).toEqual({ OrderCode: 555001 });
  });

  it('decodes a label sent as base64', async () => {
    stubFetch(json({ IsSuccess: true, Value: PDF.toString('base64') }));
    expect((await client().getShipmentLabel('1')).equals(PDF)).toBe(true);
  });

  it('downloads the file named in the wrapper, sending the key to the API host', async () => {
    const calls = stubFetch(json({ IsSuccess: true, Path: 'https://api.smoothparcel.com/Labels/1.pdf' }), pdf());
    expect((await client().getShipmentLabel('1')).equals(PDF)).toBe(true);
    expect(calls[1]).toMatchObject({ url: `${BASE}/Labels/1.pdf`, method: 'GET' });
    expect(calls[1]!.headers.Authorization).toBe(KEY);
  });

  it('passes on the reason when Smooth Parcel cannot produce the label', async () => {
    stubFetch(json({ IsSuccess: false, Message: 'No service for this postcode' }));
    await expect(client().getShipmentLabel('1')).rejects.toThrow(/could not produce the label: No service for this postcode/);
  });

  it('rejects a reply that is not a label', async () => {
    stubFetch(() => new Response('<html>error</html>', { status: 200 }));
    await expect(client().getShipmentLabel('1')).rejects.toThrow(/something other than a label PDF/);
  });
});

describe('downloadLabel', () => {
  it('retries under /api/ when the path as given is not found', async () => {
    const calls = stubFetch(status(404), pdf());
    expect((await client().downloadLabel('Labels\\555001.pdf')).equals(PDF)).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/Labels/555001.pdf`, `${BASE}/api/Labels/555001.pdf`]);
  });

  it('fetches from another Smooth Parcel host without sending it the key', async () => {
    const calls = stubFetch(pdf());
    await client().downloadLabel('https://app.smoothparcel.com/api/Labels/1.pdf');
    expect(calls[0]!.headers.Authorization).toBeUndefined();
  });

  it('refuses any host that is not Smooth Parcel', async () => {
    const calls = stubFetch(pdf());
    await expect(client().downloadLabel('https://elsewhere.example/label.pdf')).rejects.toThrow(/another host/);
    await expect(client().downloadLabel('https://smoothparcel.com.evil.example/label.pdf')).rejects.toThrow(/another host/);
    expect(calls).toHaveLength(0);
  });
});

describe('checkConnection', () => {
  it('makes one tracking lookup with the key, creating nothing', async () => {
    const calls = stubFetch(json({ IsSuccess: false, Message: 'not found' }));
    expect(await client().checkConnection()).toEqual({ apiStatus: 200 });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe('/api/APIAccess/Tracking');
    expect(calls[0]!.headers.Authorization).toBe(KEY);
  });

  it('fails when the key is refused', async () => {
    stubFetch(status(401));
    await expect(client().checkConnection()).rejects.toThrow(/refused the API key/);
  });
});

describe('account registration', () => {
  const input = {
    name: 'CleverDeals Filament Store',
    email: 'labels@example.invalid',
    password: 'correct-horse-battery',
    apiKey: KEY,
    country: 'United Kingdom',
    address1: '1 Test Street',
    city: 'Stoke-on-Trent',
    region: 'Staffordshire',
    postcode: 'ST1 1AA',
  };

  it('checks an email address without a key', async () => {
    const calls = stubFetch(json({ IsSuccess: true, Message: 'Email available' }));
    expect(await client({ apiKey: '' }).checkCustomer(input.email)).toEqual({ isSuccess: true, message: 'Email available' });
    expect(calls[0]).toMatchObject({ url: `${BASE}/api/APIAccess/CheckCustomer`, body: { EmailAddress: input.email } });
    expect(calls[0]!.headers.Authorization).toBeUndefined();
  });

  it('creates the account holding the key, as ETS did', async () => {
    const calls = stubFetch(json({ IsSuccess: true, Message: 'Customer created' }));
    expect(await client({ apiKey: '' }).createCustomer(input)).toEqual({ created: true, message: 'Customer created' });
    expect(calls[0]).toMatchObject({
      url: `${BASE}/api/APIAccess/CreateCustomer`,
      body: {
        FirstName: input.name,
        EmailAddress: input.email,
        Password: input.password,
        APIAccessKey: KEY,
        Country: 'United Kingdom',
        HouseNameNumber: '1 Test Street',
        City: 'Stoke-on-Trent',
        Region: 'Staffordshire',
        PostalCode: 'ST1 1AA',
      },
    });
  });

  it('reports a refusal without repeating a credential', async () => {
    stubFetch(json({ IsSuccess: false, Message: `Email already exist for password ${input.password}` }));
    const result = await client({ apiKey: '' }).createCustomer(input);
    expect(result.created).toBe(false);
    expect(result.message).not.toContain(input.password);
  });

  it('throws when the answer is unclear, because the account may exist', async () => {
    stubFetch(status(502));
    await expect(client({ apiKey: '' }).createCustomer(input)).rejects.toThrow(/no clear answer/);
  });
});

describe('courierNameFrom', () => {
  it('reads the carrier from the reply, in either casing, preferring the provider name', () => {
    expect(courierNameFrom({ IsSuccess: true, ShipingMethodProviderName: 'Evri', ShippingMethodName: 'Evri 48' })).toBe('Evri');
    expect(courierNameFrom({ shippingMethodName: 'Royal Mail Tracked 48' })).toBe('Royal Mail Tracked 48');
  });

  it('is null when the reply does not say', () => {
    expect(courierNameFrom({ IsSuccess: true, ShipmentCode: 1 })).toBeNull();
    expect(courierNameFrom(null)).toBeNull();
  });

  it('reads courier and service from a real AddNewOrder reply', () => {
    // Field names and values as Smooth Parcel returned them for STORE-D98D388E7288.
    const reply = {
      IsSuccess: true,
      Message: 'Label successfully generated',
      ShipmentCode: 749640,
      ShipingMethodProviderName: 'DPD',
      ShippingMethodName: 'DPD UK',
      TrackingNumber: '15503215399048',
      SmoothTrackingNo: 'SISM-MQES',
    };
    expect(courierNameFrom(reply)).toBe('DPD');
    expect(shippingServiceFrom(reply)).toBe('DPD UK');
  });
});

describe('generateApiAccessKey', () => {
  it('makes a letters-and-digits key in the shape ETS used, different every time', () => {
    const a = generateApiAccessKey();
    const b = generateApiAccessKey();
    expect(a).toMatch(/^[A-Za-z0-9]{18,22}$/);
    expect(a).not.toBe(b);
  });
});
