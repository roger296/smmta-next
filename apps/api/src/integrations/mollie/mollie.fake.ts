/**
 * In-memory Mollie fake for tests + credential-less dev (SPEC testing
 * discipline: "external HTTP is never called in tests"). Deterministic ids;
 * test helpers to drive a payment to paid/failed and simulate the thin webhook.
 */
import type {
  CreatePaymentInput,
  MollieCustomer,
  MolliePayment,
  MolliePort,
  MollieRefund,
} from './mollie.types.js';

export class FakeMollie implements MolliePort {
  private payments = new Map<string, MolliePayment>();
  private refunds = new Map<string, MollieRefund>();
  private customers = new Map<string, MollieCustomer>();
  private seq = 0;

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}_fake${this.seq.toString().padStart(6, '0')}`;
  }

  async createPayment(input: CreatePaymentInput): Promise<MolliePayment> {
    const payment: MolliePayment = {
      id: this.id('tr'),
      status: 'open',
      amountPence: input.amountPence,
      description: input.description,
      method: input.methods?.length === 1 ? input.methods[0]! : null,
      sequenceType: input.sequenceType ?? 'oneoff',
      customerId: input.customerId ?? null,
      mandateId: null,
      metadata: input.metadata ?? {},
    };
    this.payments.set(payment.id, payment);
    return { ...payment };
  }

  async getPayment(id: string): Promise<MolliePayment> {
    const p = this.payments.get(id);
    if (!p) throw new Error(`FakeMollie: unknown payment ${id}`);
    return { ...p };
  }

  async refundPayment(id: string, amountPence: number): Promise<MollieRefund> {
    const p = this.payments.get(id);
    if (!p) throw new Error(`FakeMollie: unknown payment ${id}`);
    const refund: MollieRefund = {
      id: this.id('re'),
      paymentId: id,
      amountPence,
      status: 'refunded',
    };
    this.refunds.set(refund.id, refund);
    return { ...refund };
  }

  async createCustomer(input: { email?: string; name?: string }): Promise<MollieCustomer> {
    const customer: MollieCustomer = { id: this.id('cst'), ...input };
    this.customers.set(customer.id, customer);
    return { ...customer };
  }

  async chargeMandate(input: {
    customerId: string;
    mandateId: string;
    amountPence: number;
    description: string;
    metadata?: Record<string, unknown>;
  }): Promise<MolliePayment> {
    const payment: MolliePayment = {
      id: this.id('tr'),
      status: 'paid', // mandate charges settle immediately in the fake
      amountPence: input.amountPence,
      description: input.description,
      method: 'directdebit',
      sequenceType: 'recurring',
      customerId: input.customerId,
      mandateId: input.mandateId,
      metadata: input.metadata ?? {},
    };
    this.payments.set(payment.id, payment);
    return { ...payment };
  }

  // ---- test helpers ----
  /** Drive a payment to a terminal status (simulating the customer + bank). */
  setStatus(id: string, status: MolliePayment['status'], method?: string): void {
    const p = this.payments.get(id);
    if (!p) throw new Error(`FakeMollie: unknown payment ${id}`);
    p.status = status;
    if (method) p.method = method;
  }

  reset(): void {
    this.payments.clear();
    this.refunds.clear();
    this.customers.clear();
    this.seq = 0;
  }
}
