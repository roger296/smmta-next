/**
 * Mollie wrapper — port + types (SPEC §4.7, §16). Mirrors the Luca integration
 * shape (a client class behind an interface so tests inject an in-memory fake).
 * Money is integer pence internally; the Mollie API speaks decimal strings, so
 * the client converts at the boundary. TEST mode only during the build.
 */

export type MolliePaymentStatus =
  | 'open'
  | 'pending'
  | 'paid'
  | 'failed'
  | 'canceled'
  | 'expired';

export type MollieSequenceType = 'oneoff' | 'first' | 'recurring';

export interface MolliePayment {
  id: string;
  status: MolliePaymentStatus;
  amountPence: number;
  description: string;
  method: string | null;
  sequenceType: MollieSequenceType;
  customerId?: string | null;
  mandateId?: string | null;
  metadata: Record<string, unknown>;
}

export interface CreatePaymentInput {
  amountPence: number;
  description: string;
  /** Restrict to specific methods (e.g. ['banktransfer'] for >30-day orders). */
  methods?: string[];
  sequenceType?: MollieSequenceType;
  customerId?: string;
  metadata?: Record<string, unknown>;
  redirectUrl?: string;
  webhookUrl?: string;
}

export interface MollieRefund {
  id: string;
  paymentId: string;
  amountPence: number;
  status: 'queued' | 'pending' | 'refunded' | 'failed';
}

export interface MollieCustomer {
  id: string;
  email?: string;
  name?: string;
}

/** The single interface every caller (checkout, webhooks, subscriptions) uses. */
export interface MolliePort {
  createPayment(input: CreatePaymentInput): Promise<MolliePayment>;
  getPayment(id: string): Promise<MolliePayment>;
  refundPayment(id: string, amountPence: number): Promise<MollieRefund>;
  createCustomer(input: { email?: string; name?: string }): Promise<MollieCustomer>;
  /** Charge an existing mandate on demand (subscriptions, Prompt 13). */
  chargeMandate(input: {
    customerId: string;
    mandateId: string;
    amountPence: number;
    description: string;
    metadata?: Record<string, unknown>;
  }): Promise<MolliePayment>;
}
