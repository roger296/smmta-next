/**
 * Smooth Parcel API client.
 *
 * Mirrors the Luca client: base URL and timeout from env, a single typed error,
 * and nothing about orders or storage — that lives in the shipping module.
 *
 * THE CONTRACT. The API publishes Swagger at <base>/swagger/v1/swagger.json —
 * LIVE https://api.smoothparcel.com, BETA https://api-beta.smoothparcel.com,
 * identical on both. It declares Bearer JWT auth. The token comes from the same
 * login the Smooth Parcel web portal uses:
 *
 *   POST /api/users/authenticate  { EmailAddress, password }  →  { token, … }
 *
 * WHAT SWAGGER DOES NOT DOCUMENT, and is therefore read defensively:
 *   - the AddNewOrder reply (every 200 is just "Success");
 *   - the GetShipmentLabel reply — the PDF itself, the PDF as base64, or a path
 *     to the PDF on the API host are all accepted.
 * Raw replies are kept on the label record, so the first real call is
 * debuggable rather than a silent mismatch.
 */
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
 * AddNewOrder answered success, but no order code could be read from the reply.
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
  raw: unknown;
}

export interface SmoothParcelClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** The Smooth Parcel account's email address. */
  username?: string;
  password?: string;
}

const PDF_MAGIC = '%PDF-';
/** "%PDF-" base64-encoded: how a PDF sent inside JSON starts. */
const PDF_BASE64_PREFIX = 'JVBERi0';

export class SmoothParcelClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly username: string;
  private readonly password: string;
  private token: string | null = null;
  private inflightLogin: Promise<string> | null = null;

  constructor(opts: SmoothParcelClientOptions = {}) {
    // Env is read only for what the caller did not pass, so tests need none.
    this.baseUrl = (opts.baseUrl ?? getEnv().SMOOTH_PARCEL_API_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? getEnv().SMOOTH_PARCEL_TIMEOUT_MS;
    this.username = (opts.username ?? getEnv().SMOOTH_PARCEL_USERNAME).trim();
    this.password = opts.password ?? getEnv().SMOOTH_PARCEL_PASSWORD;
  }

  /** Creates a shipment. Throws SmoothParcelUnreadableOrderError if the reply has no order code. */
  async addNewOrder(payload: SmoothParcelOrderPayload): Promise<AddNewOrderResult> {
    const res = await this.authed('POST', this.url('/api/APIAccess/AddNewOrder'), {
      body: payload,
      accept: 'application/json',
    });
    const text = await res.text().catch(() => '');
    const raw = safeJson(text) ?? text;
    const orderCode =
      bareCode(raw) ??
      pickString(raw, ['OrderCode', 'orderCode', 'ShipmentCode', 'shipmentCode', 'OrderId', 'orderId', 'Id', 'id']);
    if (!orderCode) throw new SmoothParcelUnreadableOrderError(res.status, raw);
    return {
      orderCode,
      trackingNumber: pickString(raw, [
        'SmoothParcelTrackingNumber',
        'smoothParcelTrackingNumber',
        'TrackingNumber',
        'trackingNumber',
        'TrackingCode',
        'trackingCode',
      ]),
      raw,
    };
  }

  /** Fetches the label for a shipment. Throws unless what comes back is a real PDF. */
  async getShipmentLabel(orderCode: string): Promise<Buffer> {
    // OrderCode is an int32 in the published contract.
    const code = /^\d+$/.test(orderCode) ? Number(orderCode) : orderCode;
    const res = await this.authed('POST', this.url('/api/APIAccess/GetShipmentLabel'), {
      body: { OrderCode: code },
      accept: 'application/pdf, application/json',
    });
    const buf = Buffer.from(await res.arrayBuffer());
    if (isPdf(buf)) return buf;

    const text = buf.toString('utf8');
    const parsed = safeJson(text) ?? text;
    const b64 = findString(parsed, (s) => s.trim().startsWith(PDF_BASE64_PREFIX));
    if (b64) {
      const pdf = Buffer.from(b64.trim(), 'base64');
      if (isPdf(pdf)) return pdf;
    }
    const path = findString(parsed, (s) => /\.pdf(\?.*)?$/i.test(s.trim()));
    if (path) return this.fetchLabelFile(path.trim());

    // Checked, not assumed: an error page served with a 200 would otherwise be
    // saved as a "label" that opens as garbage at the packing bench.
    throw new SmoothParcelApiError(
      'Smooth Parcel returned something other than a label PDF',
      res.status,
      text.slice(0, 300),
    );
  }

  /**
   * Logs in and makes one read-only call — a tracking lookup for a number that
   * does not exist — to prove the credentials work without creating anything.
   */
  async checkConnection(): Promise<{ apiStatus: number }> {
    const token = await this.login();
    const res = await this.send('POST', this.url('/api/APIAccess/Tracking'), {
      body: { SmoothParcelTrackingNumber: 'CONNECTION-CHECK' },
      token,
      accept: 'application/json',
    });
    if (res.status === 401 || res.status === 403) {
      throw new SmoothParcelApiError(`Logged in, but Smooth Parcel refused API access (${res.status})`, res.status);
    }
    return { apiStatus: res.status };
  }

  /** A label handed back as a path is fetched from the API's own host, never anywhere else. */
  private async fetchLabelFile(pathOrUrl: string): Promise<Buffer> {
    const base = new URL(`${this.baseUrl}/`);
    let target: URL;
    try {
      target = new URL(pathOrUrl.replace(/\\/g, '/'), base);
    } catch {
      throw new SmoothParcelApiError('Smooth Parcel returned a label location that is not a valid path', 0, pathOrUrl);
    }
    if (target.origin !== base.origin) {
      throw new SmoothParcelApiError(
        `Smooth Parcel pointed the label at another host (${target.host || target.protocol}); refusing to fetch it`,
        0,
        pathOrUrl,
      );
    }
    const res = await this.authed('GET', target.toString(), { accept: 'application/pdf' });
    const buf = Buffer.from(await res.arrayBuffer());
    if (!isPdf(buf)) {
      throw new SmoothParcelApiError(
        'The label file Smooth Parcel pointed to is not a PDF',
        res.status,
        buf.subarray(0, 300).toString('utf8'),
      );
    }
    return buf;
  }

  /** One login per client, shared by concurrent callers. */
  private async login(): Promise<string> {
    if (this.inflightLogin) return this.inflightLogin;
    this.inflightLogin = (async () => {
      try {
        if (!this.username || !this.password) {
          throw new SmoothParcelApiError(
            'Smooth Parcel username and password are not set (SMOOTH_PARCEL_USERNAME / SMOOTH_PARCEL_PASSWORD)',
            0,
          );
        }
        const res = await this.send('POST', this.url('/api/users/authenticate'), {
          body: { EmailAddress: this.username, password: this.password },
          accept: 'application/json',
        });
        const text = await res.text().catch(() => '');
        if (!res.ok) {
          // The reply is deliberately not echoed: this message is stored and
          // logged, and nothing about a login is worth risking the credentials for.
          throw new SmoothParcelApiError(
            `Smooth Parcel login was rejected (${res.status}) — check SMOOTH_PARCEL_USERNAME and SMOOTH_PARCEL_PASSWORD`,
            res.status,
          );
        }
        const token = pickString(safeJson(text), ['token', 'Token', 'access_token', 'accessToken']);
        if (!token) throw new SmoothParcelApiError('Smooth Parcel login succeeded but returned no token', res.status);
        this.token = token;
        return token;
      } finally {
        this.inflightLogin = null;
      }
    })();
    return this.inflightLogin;
  }

  /** Sends with the token, logging in again and retrying once if it has expired. */
  private async authed(
    method: 'GET' | 'POST',
    url: string,
    opts: { body?: unknown; accept: string },
  ): Promise<Response> {
    let res = await this.send(method, url, { ...opts, token: this.token ?? (await this.login()) });
    if (res.status === 401) {
      // A 401 means the request was not processed, so retrying cannot duplicate
      // a shipment.
      this.token = null;
      res = await this.send(method, url, { ...opts, token: await this.login() });
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
    opts: { body?: unknown; token?: string; accept: string },
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: opts.accept };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
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

/** A reply that is nothing but the order code. */
function bareCode(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return String(raw);
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return raw.trim();
  return null;
}

/** First non-empty string/number at any of `keys`, top level or one wrapper deep. */
function pickString(raw: unknown, keys: string[]): string | null {
  const layers: unknown[] = [raw];
  if (raw && typeof raw === 'object') {
    for (const wrapper of ['Data', 'data', 'Result', 'result']) {
      const inner = (raw as Record<string, unknown>)[wrapper];
      if (inner && typeof inner === 'object') layers.push(inner);
    }
  }
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    for (const key of keys) {
      const v = (layer as Record<string, unknown>)[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
  }
  return null;
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
