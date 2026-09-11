/**
 * Smooth Parcel API client.
 *
 * Mirrors the Luca client: base URL and timeout from env, a single typed error,
 * and nothing about orders or storage — that lives in the shipping module.
 *
 * THE CONTRACT. The API publishes Swagger at <base>/swagger/v1/swagger.json —
 * LIVE https://api.smoothparcel.com, BETA https://api-beta.smoothparcel.com.
 * Swagger describes neither authentication nor replies, so both follow the
 * ETS/SMMTA .NET application, which shipped through this API in production
 * (CustomerOrderServices.SaveAndGenerateLabelOfLBFromService):
 *
 *   - every APIAccess call sends the account's API access key as the raw
 *     Authorization header, with no "Bearer". The web login's JWT is refused.
 *   - the key is set when the account is created, by APIAccess/CreateCustomer,
 *     which needs no key (scripts/register-smooth-parcel-account.ts).
 *   - replies are a wrapper: IsSuccess, Message, ShipmentCode, TrackingNumber,
 *     Path, shipmentLabelList[{ FilePath, TrackNumber }]. AddNewOrder returns
 *     the label with the shipment; GetShipmentLabel returns it again.
 *
 * Field names are matched case-insensitively, and raw replies are kept on the
 * label record, so a difference in casing or shape shows up rather than hiding.
 */
import { randomBytes } from 'node:crypto';
import { getEnv } from '../../config/env.js';
import type { SmoothParcelOrderPayload } from '../../modules/shipping/smooth-parcel-mapper.js';

export class SmoothParcelApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'SmoothParcelApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * AddNewOrder did not say no, but no shipment code could be read from the reply.
 * The shipment may well exist and be charged for, so this must never be retried
 * blindly: the caller records the reply for a person to check.
 */
export class SmoothParcelUnreadableOrderError extends SmoothParcelApiError {
  constructor(status: number, body: unknown) {
    const excerpt = typeof body === 'string' ? body : JSON.stringify(body);
    super(
      `Smooth Parcel accepted the shipment but its reply had no order code we could read: ${(excerpt ?? '').slice(0, 300)}`,
      status,
      body,
    );
    this.name = 'SmoothParcelUnreadableOrderError';
  }
}

export interface AddNewOrderResult {
  orderCode: string;
  trackingNumber: string | null;
  /** Where the label created with the shipment can be downloaded, when the reply says. */
  labelPath?: string | null;
  raw: unknown;
}

export interface SmoothParcelClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  apiKey?: string;
}

export interface CreateCustomerInput {
  name: string;
  email: string;
  password: string;
  apiKey: string;
  country: string;
  address1?: string;
  city?: string;
  region?: string;
  postcode?: string;
}

const PDF_MAGIC = '%PDF-';
/** "%PDF-" base64-encoded: how a PDF sent inside JSON starts. */
const PDF_BASE64_PREFIX = 'JVBERi0';

/** A key in the shape ETS generated: a random 128-bit value in base64, letters and digits only. */
export function generateApiAccessKey(): string {
  return randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

export class SmoothParcelClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly apiKey: string;

  constructor(opts: SmoothParcelClientOptions = {}) {
    // Env is read only for what the caller did not pass, so tests need none.
    this.baseUrl = (opts.baseUrl ?? getEnv().SMOOTH_PARCEL_API_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? getEnv().SMOOTH_PARCEL_TIMEOUT_MS;
    this.apiKey = (opts.apiKey ?? getEnv().SMOOTH_PARCEL_API_KEY).trim();
  }

  /**
   * Creates a shipment. A definite refusal (IsSuccess false, no shipment code)
   * throws SmoothParcelApiError; a reply that is neither a refusal nor readable
   * throws SmoothParcelUnreadableOrderError.
   */
  async addNewOrder(payload: SmoothParcelOrderPayload): Promise<AddNewOrderResult> {
    const res = await this.keyed(this.url('/api/APIAccess/AddNewOrder'), payload, 'application/json');
    const text = await res.text().catch(() => '');
    const raw = safeJson(text) ?? text;
    const orderCode = bareCode(raw) ?? pickCode(raw, ['ShipmentCode', 'OrderCode']);
    if (!orderCode) {
      if (getField(raw, 'IsSuccess') === false) {
        // A definite no: nothing was created, so this is an ordinary failure.
        throw new SmoothParcelApiError(
          `Smooth Parcel refused the shipment: ${messageOf(raw) ?? 'no reason given'}`,
          res.status,
          raw,
        );
      }
      throw new SmoothParcelUnreadableOrderError(res.status, raw);
    }
    return { orderCode, trackingNumber: trackingOf(raw), labelPath: labelPathOf(raw), raw };
  }

  /** Fetches the label for a shipment. Throws unless what comes back is a real PDF. */
  async getShipmentLabel(orderCode: string): Promise<Buffer> {
    // OrderCode is an int32 in the published contract.
    const code = /^\d+$/.test(orderCode) ? Number(orderCode) : orderCode;
    const res = await this.keyed(
      this.url('/api/APIAccess/GetShipmentLabel'),
      { OrderCode: code },
      'application/pdf, application/json',
    );
    const buf = Buffer.from(await res.arrayBuffer());
    if (isPdf(buf)) return buf;

    const text = buf.toString('utf8');
    const parsed = safeJson(text) ?? text;
    if (getField(parsed, 'IsSuccess') === false) {
      throw new SmoothParcelApiError(
        `Smooth Parcel could not produce the label: ${messageOf(parsed) ?? 'no reason given'}`,
        res.status,
        text.slice(0, 300),
      );
    }
    const b64 = findString(parsed, (s) => s.trim().startsWith(PDF_BASE64_PREFIX));
    if (b64) {
      const pdf = Buffer.from(b64.trim(), 'base64');
      if (isPdf(pdf)) return pdf;
    }
    const path = labelPathOf(parsed);
    if (path) return this.downloadLabel(path);

    // Checked, not assumed: an error page served with a 200 would otherwise be
    // saved as a "label" that opens as garbage at the packing bench.
    throw new SmoothParcelApiError(
      'Smooth Parcel returned something other than a label PDF',
      res.status,
      text.slice(0, 300),
    );
  }

  /**
   * Downloads a label file from the path or URL a reply gave. Only Smooth
   * Parcel's own hosts are fetched, and the key is sent to the configured API
   * host only. ETS found label files under /api/ even when the path lacked it,
   * so a 404 is retried there once.
   */
  async downloadLabel(pathOrUrl: string): Promise<Buffer> {
    const base = new URL(`${this.baseUrl}/`);
    let target: URL;
    try {
      target = new URL(pathOrUrl.trim().replace(/\\/g, '/'), base);
    } catch {
      throw new SmoothParcelApiError('Smooth Parcel returned a label location that is not a valid path', 0, pathOrUrl);
    }
    const smoothParcelHost =
      target.protocol === 'https:' && (target.hostname === 'smoothparcel.com' || target.hostname.endsWith('.smoothparcel.com'));
    if (target.origin !== base.origin && !smoothParcelHost) {
      throw new SmoothParcelApiError(
        `Smooth Parcel pointed the label at another host (${target.host || target.protocol}); refusing to fetch it`,
        0,
        pathOrUrl,
      );
    }

    const attempts = [target];
    if (!target.pathname.toLowerCase().startsWith('/api/')) {
      const withApi = new URL(target.toString());
      withApi.pathname = `/api${target.pathname}`;
      attempts.push(withApi);
    }
    let res: Response | null = null;
    for (const url of attempts) {
      const headers: Record<string, string> = { Accept: 'application/pdf' };
      if (url.origin === base.origin && this.apiKey) headers.Authorization = this.apiKey;
      res = await this.send('GET', url.toString(), { headers });
      if (res.status !== 404) break;
    }
    if (!res!.ok) {
      throw new SmoothParcelApiError(`Could not download the label from Smooth Parcel (HTTP ${res!.status})`, res!.status, pathOrUrl);
    }
    const buf = Buffer.from(await res!.arrayBuffer());
    if (!isPdf(buf)) {
      throw new SmoothParcelApiError(
        'The label file Smooth Parcel pointed to is not a PDF',
        res!.status,
        buf.subarray(0, 300).toString('utf8'),
      );
    }
    return buf;
  }

  /**
   * Sends the key on one read-only call — a tracking lookup for a number that
   * does not exist — to prove it is accepted without creating anything.
   */
  async checkConnection(): Promise<{ apiStatus: number }> {
    this.requireKey();
    const res = await this.send('POST', this.url('/api/APIAccess/Tracking'), {
      body: { SmoothParcelTrackingNumber: 'CONNECTION-CHECK' },
      headers: { Accept: 'application/json', Authorization: this.apiKey },
    });
    if (res.status === 401 || res.status === 403) {
      throw new SmoothParcelApiError(`Smooth Parcel refused the API key (${res.status}) — check SMOOTH_PARCEL_API_KEY`, res.status);
    }
    return { apiStatus: res.status };
  }

  /** Smooth Parcel's answer for an email address. Needs no key. ETS read IsSuccess=true as "free to register". */
  async checkCustomer(email: string): Promise<{ isSuccess: boolean | null; message: string | null }> {
    const res = await this.send('POST', this.url('/api/APIAccess/CheckCustomer'), {
      body: { EmailAddress: email },
      headers: { Accept: 'application/json' },
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throw new SmoothParcelApiError(
        `Smooth Parcel CheckCustomer returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
        res.status,
        text,
      );
    }
    const reply = safeJson(text);
    const ok = getField(reply, 'IsSuccess');
    return { isSuccess: typeof ok === 'boolean' ? ok : null, message: messageOf(reply) };
  }

  /**
   * Creates a Smooth Parcel account that holds `apiKey`, as ETS did. Needs no
   * key. Returns created=false only for a definite refusal; anything unclear
   * throws, because the account may exist.
   */
  async createCustomer(input: CreateCustomerInput): Promise<{ created: boolean; message: string | null }> {
    const res = await this.send('POST', this.url('/api/APIAccess/CreateCustomer'), {
      body: {
        FirstName: input.name,
        EmailAddress: input.email,
        Password: input.password,
        APIAccessKey: input.apiKey,
        Country: input.country,
        HouseNameNumber: input.address1 ?? '',
        Street: input.address1 ?? '',
        City: input.city ?? '',
        Region: input.region ?? '',
        PostalCode: input.postcode ?? '',
      },
      headers: { Accept: 'application/json' },
    });
    const text = await res.text().catch(() => '');
    const reply = safeJson(text);
    const said = messageOf(reply);
    // Never pass on a message that echoes the password or the key.
    const message =
      said && (said.includes(input.password) || said.includes(input.apiKey))
        ? '(message withheld because it repeated a credential)'
        : (said?.slice(0, 200) ?? null);
    const ok = getField(reply, 'IsSuccess');

    if (res.ok && ok === true) return { created: true, message };
    if ((res.ok && ok === false) || (res.status >= 400 && res.status < 500)) return { created: false, message };
    throw new SmoothParcelApiError(`Smooth Parcel CreateCustomer gave no clear answer (HTTP ${res.status})`, res.status);
  }

  private requireKey(): void {
    if (!this.apiKey) {
      throw new SmoothParcelApiError('Smooth Parcel API key is not set (SMOOTH_PARCEL_API_KEY)', 0);
    }
  }

  /** An APIAccess POST authenticated with the key. Throws on anything but a 2xx. */
  private async keyed(url: string, body: unknown, accept: string): Promise<Response> {
    this.requireKey();
    const res = await this.send('POST', url, { body, headers: { Accept: accept, Authorization: this.apiKey } });
    if (res.status === 401 || res.status === 403) {
      throw new SmoothParcelApiError(`Smooth Parcel refused the API key (${res.status}) — check SMOOTH_PARCEL_API_KEY`, res.status);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new SmoothParcelApiError(
        `Smooth Parcel ${pathOf(url)} returned ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
        res.status,
        text,
      );
    }
    return res;
  }

  private async send(
    method: 'GET' | 'POST',
    url: string,
    opts: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await fetch(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new SmoothParcelApiError(`Smooth Parcel request to ${pathOf(url)} failed: ${reason}`, 0);
    }
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }
}

function isPdf(buf: Buffer): boolean {
  return buf.subarray(0, 5).toString('latin1') === PDF_MAGIC;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** A field of a plain object, matching its name case-insensitively. */
function getField(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const want = key.toLowerCase();
  for (const [k, v] of Object.entries(value)) {
    if (k.toLowerCase() === want) return v;
  }
  return undefined;
}

/** The reply itself, plus a Data or Result wrapper if it has one. */
function layers(raw: unknown): unknown[] {
  const out = [raw];
  for (const wrapper of ['Data', 'Result']) {
    const inner = getField(raw, wrapper);
    if (inner && typeof inner === 'object') out.push(inner);
  }
  return out;
}

/** First non-empty string (or number) at any of `keys`. */
function pickString(raw: unknown, keys: string[]): string | null {
  for (const layer of layers(raw)) {
    for (const key of keys) {
      const v = getField(layer, key);
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
  }
  return null;
}

/** First positive whole number at any of `keys`. The wrapper sends OrderCode 0 when there is none. */
function pickCode(raw: unknown, keys: string[]): string | null {
  for (const layer of layers(raw)) {
    for (const key of keys) {
      const v = getField(layer, key);
      if (typeof v === 'number' && Number.isInteger(v) && v > 0) return String(v);
      if (typeof v === 'string' && /^\d+$/.test(v.trim()) && Number(v) > 0) return v.trim();
    }
  }
  return null;
}

/** A reply that is nothing but the order code. */
function bareCode(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return String(raw);
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim()) && Number(raw) > 0) return raw.trim();
  return null;
}

/**
 * The carrier Smooth Parcel chose for a shipment, read from its reply, for
 * telling the customer who is delivering. Null when the reply does not say.
 */
export function courierNameFrom(raw: unknown): string | null {
  return pickString(raw, [
    'ShipingMethodProviderName',
    'ShippingMethodProviderName',
    'ShipmentProviderName',
    'CourierName',
    'ShippingMethodName',
  ]);
}

function messageOf(raw: unknown): string | null {
  return pickString(raw, ['Message', 'title']);
}

function firstLabel(raw: unknown): unknown {
  for (const layer of layers(raw)) {
    const list = getField(layer, 'shipmentLabelList');
    if (Array.isArray(list) && list.length > 0) return list[0];
  }
  return null;
}

function trackingOf(raw: unknown): string | null {
  return (
    pickString(raw, ['TrackingNumber', 'SmoothTrackingNo', 'SmoothParcelTrackingNumber', 'TrackNumber']) ??
    pickString(firstLabel(raw), ['TrackNumber'])
  );
}

function labelPathOf(raw: unknown): string | null {
  return (
    pickString(firstLabel(raw), ['FilePath']) ??
    pickString(raw, ['Path', 'LabelPath', 'FilePath']) ??
    findString(raw, (s) => /\.pdf(\?.*)?$/i.test(s.trim()))
  );
}

/** First string anywhere in a small JSON value that satisfies `test`. */
function findString(value: unknown, test: (s: string) => boolean, depth = 0): string | null {
  if (typeof value === 'string') return test(value) ? value : null;
  if (!value || typeof value !== 'object' || depth > 4) return null;
  for (const v of Array.isArray(value) ? value : Object.values(value)) {
    const found = findString(v, test, depth + 1);
    if (found) return found;
  }
  return null;
}
