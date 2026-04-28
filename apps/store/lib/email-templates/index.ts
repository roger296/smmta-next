/**
 * Typed transactional email templates.
 *
 * Each template is a pure function from a typed payload to
 * `{ subject, html, text, preheader }`. We render in TS rather than via
 * SendGrid Dynamic Templates because:
 *   - the payload shape is type-checked end-to-end (no surprise nulls)
 *   - rendering is unit-testable without standing up SendGrid
 *   - shipping content changes is a code review, not a SendGrid dashboard
 *     edit done out of band
 *
 * Plain-text bodies are not optional — they're required for
 * deliverability (Gmail tabs, plus accessibility). We hand-write them
 * rather than HTML-strip the rich body.
 */
import { renderOrderConfirmation, type OrderConfirmationPayload } from './order-confirmation';
import { renderOrderShipped, type OrderShippedPayload } from './order-shipped';
import { renderOrderCancelled, type OrderCancelledPayload } from './order-cancelled';
import { renderRefundIssued, type RefundIssuedPayload } from './refund-issued';

export type TemplateName =
  | 'order_confirmation'
  | 'order_shipped'
  | 'order_cancelled'
  | 'refund_issued';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  /** Preview text shown next to the subject in inboxes. ~85 chars max. */
  preheader: string;
}

export interface TemplatePayloads {
  order_confirmation: OrderConfirmationPayload;
  order_shipped: OrderShippedPayload;
  order_cancelled: OrderCancelledPayload;
  refund_issued: RefundIssuedPayload;
}

/**
 * Pure renderer dispatch. The runtime check on `template` is intentional:
 * payloads come from a JSONB column at send time, so even though the
 * compile-time mapping is sound, a stale DB row could pass through.
 */
export function renderTemplate<T extends TemplateName>(
  template: T,
  payload: TemplatePayloads[T],
): RenderedEmail {
  switch (template) {
    case 'order_confirmation':
      return renderOrderConfirmation(payload as OrderConfirmationPayload);
    case 'order_shipped':
      return renderOrderShipped(payload as OrderShippedPayload);
    case 'order_cancelled':
      return renderOrderCancelled(payload as OrderCancelledPayload);
    case 'refund_issued':
      return renderRefundIssued(payload as RefundIssuedPayload);
    default: {
      const exhaustive: never = template;
      throw new Error(`Unknown template: ${String(exhaustive)}`);
    }
  }
}

export type {
  OrderConfirmationPayload,
  OrderShippedPayload,
  OrderCancelledPayload,
  RefundIssuedPayload,
};
