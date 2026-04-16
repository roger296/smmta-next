import { getEnv } from '../../config/env.js';
import type {
  LucaPostTransactionRequest,
  LucaPostTransactionResponse,
  LucaPeriodStatusResponse,
  LucaYearEndCloseRequest,
} from './luca-types.js';

/**
 * HTTP client for the Luca General Ledger REST API.
 * Wraps fetch with base URL, timeouts, and error handling.
 */
export class LucaClient {
  private baseUrl: string;
  private timeoutMs: number;

  constructor(baseUrl?: string, timeoutMs?: number) {
    const env = getEnv();
    this.baseUrl = baseUrl ?? env.LUCA_API_BASE_URL;
    this.timeoutMs = timeoutMs ?? env.LUCA_API_TIMEOUT_MS;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const json = await res.json() as T & { error?: string };

      if (!res.ok) {
        throw new LucaApiError(
          `Luca API ${method} ${path} returned ${res.status}: ${json.error ?? res.statusText}`,
          res.status,
          json,
        );
      }

      return json;
    } catch (err) {
      if (err instanceof LucaApiError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new LucaApiError(`Luca API request timed out after ${this.timeoutMs}ms`, 408);
      }
      throw new LucaApiError(`Luca API request failed: ${(err as Error).message}`, 0);
    } finally {
      clearTimeout(timeout);
    }
  }

  // === Transactions ===

  async postTransaction(req: LucaPostTransactionRequest): Promise<LucaPostTransactionResponse> {
    return this.request<LucaPostTransactionResponse>('POST', '/api/v1/transactions', req);
  }

  // === Period Management ===

  async getPeriodStatus(periodId: string): Promise<LucaPeriodStatusResponse> {
    return this.request<LucaPeriodStatusResponse>('GET', `/api/v1/periods/${periodId}`);
  }

  // === Year-End ===

  async yearEndClose(req: LucaYearEndCloseRequest): Promise<unknown> {
    return this.request('POST', '/api/v1/year-end-close', req);
  }

  // === Accounts ===

  async createAccount(data: {
    code: string;
    name: string;
    type: string;
    category?: string;
  }): Promise<unknown> {
    return this.request('POST', '/api/v1/accounts', data);
  }

  async listAccounts(): Promise<unknown> {
    return this.request('GET', '/api/v1/accounts');
  }

  async getAccountBalance(accountCode: string, asAtDate?: string): Promise<unknown> {
    const qs = asAtDate ? `?as_at_date=${asAtDate}` : '';
    return this.request('GET', `/api/v1/accounts/${accountCode}/balance${qs}`);
  }

  // === Queries ===

  async queryJournal(params: Record<string, string>): Promise<unknown> {
    const qs = new URLSearchParams(params).toString();
    return this.request('GET', `/api/v1/journal?${qs}`);
  }

  async getTrialBalance(periodId: string): Promise<unknown> {
    return this.request('GET', `/api/v1/trial-balance/${periodId}`);
  }
}

/**
 * Custom error class for Luca API failures.
 */
export class LucaApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = 'LucaApiError';
  }
}
