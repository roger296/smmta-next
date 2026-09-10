/**
 * Smooth Parcel API client.
 *
 * Mirrors the Luca client: base URL and timeout from env, a single typed error,
 * and nothing about orders or storage — that lives in the shipping module.
 *
 * WHAT IS CONFIRMED (Smooth Parcel user guide V5, 2018):
 *   - POST /api/APIAccess/AddNewOrder     JSON shipment → creates a shipment
 *   - POST /api/APIAccess/GetShipmentLabel { "OrderCode": … } → the label PDF
 *
 * WHAT IS NOT, and is isolated so it is one edit when the developer pack lands:
 *   - the authentication scheme (headers() below);
 *   - the shape of the AddNewOrder response (orderCodeFrom / trackingFrom).
 *
 * The response is parsed defensively and the raw body is kept on the label
 * record, so the first real call is debuggable rather than a silent mismatch.
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

export interface AddNewOrderResult {
  orderCode: string;
  trackingNumber: string | null;
  raw: unknown;
}

export interface SmoothParcelClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  apiKey?: string;
}

export class SmoothParcelClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly apiKey: string;

  constructor(opts: SmoothParcelClientOptions = {}) {
    const env = getEnv();
    this.baseUrl = (opts.baseUrl ?? env.SMOOTH_PARCEL_API_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? env.SMOOTH_PARCEL_TIMEOUT_MS;
    this.apiKey = opts.apiKey ?? env.SMOOTH_PARCEL_API_KEY;
  }

  /**
   * AUTH IS UNCONFIRMED. Neither the user guide nor the tracking API documents
   * an authentication header; the developer pack does. Until it is in hand the
   * key is sent as a bearer token. Change this one function to match.
   */
  private headers(accept: string): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: accept };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private async post(path: string, body: unknown, accept: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers(accept),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new SmoothParcelApiError(`Smooth Parcel request to ${path} failed: ${reason}`, 0);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new SmoothParcelApiError(
        `Smooth Parcel ${path} returned ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
        res.status,
        text,
      );
    }
    return res;
  }

  /** Creates a shipment. Throws if the response carries no order code. */
  async addNewOrder(payload: SmoothParcelOrderPayload): Promise<AddNewOrderResult> {
    const res = await this.post('/api/APIAccess/AddNewOrder', payload, 'application/json');
    const raw: unknown = await res.json().catch(() => null);
    const orderCode = pickString(raw, ['OrderCode', 'orderCode', 'OrderId', 'orderId', 'Id', 'id']);
    if (!orderCode) {
      throw new SmoothParcelApiError(
        'Smooth Parcel accepted the shipment but its response had no order code to fetch a label with',
        res.status,
        raw,
      );
    }
    return {
      orderCode,
      trackingNumber: pickString(raw, ['TrackingNumber', 'trackingNumber', 'TrackingCode', 'trackingCode']),
      raw,
    };
  }

  /** Fetches the label for a shipment. Throws unless the body is a real PDF. */
  async getShipmentLabel(orderCode: string): Promise<Buffer> {
    // The guide's example sends OrderCode as a number.
    const code = /^\d+$/.test(orderCode) ? Number(orderCode) : orderCode;
    const res = await this.post('/api/APIAccess/GetShipmentLabel', { OrderCode: code }, 'application/pdf');
    const buf = Buffer.from(await res.arrayBuffer());
    // Checked, not assumed: an error page served with a 200 would otherwise be
    // saved as a "label" that opens as garbage at the packing bench.
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new SmoothParcelApiError(
        'Smooth Parcel returned something other than a PDF for the label',
        res.status,
        buf.subarray(0, 300).toString('utf8'),
      );
    }
    return buf;
  }
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
