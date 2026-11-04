/**
 * Bouncer address verification client (spec § Address verification with
 * Bouncer). Single checks run in a worker job after the contact is saved —
 * never in a request path. Batch checks re-verify dormant contacts before a
 * win-back. The key comes from BOUNCER_API_KEY and is never logged.
 *
 * API (usebouncer.com, v1.1):
 *   GET  /email/verify?email=…                     → { email, status, reason, … }
 *   POST /email/verify/batch  [{ email }]          → { batchId, … }
 *   GET  /email/verify/batch/{id}                  → { status: queued|processing|completed, … }
 *   GET  /email/verify/batch/{id}/download?download=all → [{ email, status, reason, … }]
 */
import { getEnv } from '../../../config/env.js';

export type BouncerStatus = 'deliverable' | 'undeliverable' | 'risky' | 'unknown';

export interface BouncerResult {
  email: string;
  status: BouncerStatus;
  reason: string | null;
  raw: Record<string, unknown>;
}

export class BouncerError extends Error {
  constructor(
    message: string,
    /** Worth trying again later (timeout, 429, 5xx). */
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

const STATUSES: BouncerStatus[] = ['deliverable', 'undeliverable', 'risky', 'unknown'];

function toResult(raw: Record<string, unknown>, fallbackEmail: string): BouncerResult {
  const status = STATUSES.includes(raw.status as BouncerStatus) ? (raw.status as BouncerStatus) : 'unknown';
  return {
    email: typeof raw.email === 'string' ? raw.email : fallbackEmail,
    status,
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    raw,
  };
}

export interface BouncerClientOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Single-check timeout (10 s). */
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class BouncerClient {
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;
  private pollIntervalMs: number;
  private maxWaitMs: number;
  private sleep: (ms: number) => Promise<void>;

  constructor(opts: BouncerClientOptions = {}) {
    const env = getEnv();
    this.apiKey = opts.apiKey ?? env.BOUNCER_API_KEY;
    this.baseUrl = (opts.baseUrl ?? env.BOUNCER_API_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 30_000;
    this.maxWaitMs = opts.maxWaitMs ?? 2 * 3_600_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  private async call(path: string, init: RequestInit = {}, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (!this.apiKey) throw new BouncerError('BOUNCER_API_KEY is not set', false);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new BouncerError(`Bouncer request failed: ${err instanceof Error ? err.name : 'error'}`, true);
    }
    if (res.status === 429 || res.status >= 500) throw new BouncerError(`Bouncer ${res.status}`, true);
    if (!res.ok) throw new BouncerError(`Bouncer ${res.status}`, false);
    return res.json();
  }

  async verify(email: string): Promise<BouncerResult> {
    const raw = (await this.call(`/email/verify?email=${encodeURIComponent(email)}&timeout=${Math.floor(this.timeoutMs / 1000)}`)) as Record<string, unknown>;
    return toResult(raw, email);
  }

  /** Verify many addresses with the batch endpoint; polls until complete. */
  async verifyBatch(emails: string[]): Promise<BouncerResult[]> {
    if (emails.length === 0) return [];
    const created = (await this.call(
      '/email/verify/batch',
      { method: 'POST', body: JSON.stringify(emails.map((email) => ({ email }))) },
      60_000,
    )) as { batchId?: string };
    if (!created.batchId) throw new BouncerError('Bouncer batch: no batch id', false);
    const started = Date.now();
    for (;;) {
      const s = (await this.call(`/email/verify/batch/${encodeURIComponent(created.batchId)}`, {}, 30_000)) as { status?: string };
      if (s.status === 'completed') break;
      if (Date.now() - started >= this.maxWaitMs) throw new BouncerError('Bouncer batch did not finish in time', true);
      await this.sleep(this.pollIntervalMs);
    }
    const rows = (await this.call(
      `/email/verify/batch/${encodeURIComponent(created.batchId)}/download?download=all`,
      {},
      60_000,
    )) as Array<Record<string, unknown>>;
    return rows.map((r) => toResult(r, String(r.email ?? '')));
  }
}
