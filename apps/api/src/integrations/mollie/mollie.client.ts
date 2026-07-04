/**
 * Real Mollie HTTP client (Payments API, NOT the Orders API — SPEC §4.7).
 * TEST mode only during the build; requires MOLLIE_API_KEY. Never exercised in
 * tests (the fake is injected). Converts integer pence ↔ Mollie decimal strings
 * at the boundary. BLOCKED until a test key is supplied (see BUILD_LOG).
 */
import { getEnv } from '../../config/env.js';
import type {
  CreatePaymentInput,
  MollieCustomer,
  MolliePayment,
  MolliePaymentStatus,
  MolliePort,
  MollieRefund,
} from './mollie.types.js';

const penceToDecimal = (pence: number): string => (pence / 100).toFixed(2);
const decimalToPence = (value: string): number => Math.round(parseFloat(value) * 100);

interface MollieApiPayment {
  id: string;
  status: MolliePaymentStatus;
  amount: { value: string; currency: string };
  description: string;
  method: string | null;
  sequenceType: MolliePayment['sequenceType'];
  customerId?: string | null;
  mandateId?: string | null;
  metadata: Record<string, unknown> | null;
}

export class MollieClient implements MolliePort {
  private apiKey: string;
  private base = 'https://api.mollie.com/v2';

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? getEnv().MOLLIE_API_KEY;
    if (!this.apiKey) throw new Error('MollieClient: MOLLIE_API_KEY is not set (BLOCKED)');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as T & { detail?: string };
    if (!res.ok) throw new Error(`Mollie ${method} ${path} failed: ${json.detail ?? res.status}`);
    return json;
  }

  private normalise(p: MollieApiPayment): MolliePayment {
    return {
      id: p.id,
      status: p.status,
      amountPence: decimalToPence(p.amount.value),
      description: p.description,
      method: p.method,
      sequenceType: p.sequenceType,
      customerId: p.customerId ?? null,
      mandateId: p.mandateId ?? null,
      metadata: p.metadata ?? {},
    };
  }

  async createPayment(input: CreatePaymentInput): Promise<MolliePayment> {
    const p = await this.request<MollieApiPayment>('POST', '/payments', {
      amount: { currency: 'GBP', value: penceToDecimal(input.amountPence) },
      description: input.description,
      method: input.methods,
      sequenceType: input.sequenceType ?? 'oneoff',
      customerId: input.customerId,
      metadata: input.metadata,
      redirectUrl: input.redirectUrl,
      webhookUrl: input.webhookUrl,
    });
    return this.normalise(p);
  }

  async getPayment(id: string): Promise<MolliePayment> {
    return this.normalise(await this.request<MollieApiPayment>('GET', `/payments/${id}`));
  }

  async refundPayment(id: string, amountPence: number): Promise<MollieRefund> {
    const r = await this.request<{ id: string; status: MollieRefund['status'] }>(
      'POST',
      `/payments/${id}/refunds`,
      { amount: { currency: 'GBP', value: penceToDecimal(amountPence) } },
    );
    return { id: r.id, paymentId: id, amountPence, status: r.status };
  }

  async createCustomer(input: { email?: string; name?: string }): Promise<MollieCustomer> {
    const c = await this.request<{ id: string; email?: string; name?: string }>(
      'POST',
      '/customers',
      input,
    );
    return { id: c.id, email: c.email, name: c.name };
  }

  async chargeMandate(input: {
    customerId: string;
    mandateId: string;
    amountPence: number;
    description: string;
    metadata?: Record<string, unknown>;
  }): Promise<MolliePayment> {
    const p = await this.request<MollieApiPayment>('POST', '/payments', {
      amount: { currency: 'GBP', value: penceToDecimal(input.amountPence) },
      description: input.description,
      customerId: input.customerId,
      mandateId: input.mandateId,
      sequenceType: 'recurring',
      metadata: input.metadata,
    });
    return this.normalise(p);
  }
}
