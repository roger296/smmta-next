import type { RenderedEmail } from './index';
import { escapeHtml, htmlWrapper, trackUrl } from './shared';

export interface OrderCancelledPayload {
  orderId: string;
  orderNumber: string;
  firstName?: string;
  storeBaseUrl: string;
  /** Optional human-readable reason — surfaced verbatim. */
  reason?: string;
}

export function renderOrderCancelled(p: OrderCancelledPayload): RenderedEmail {
  const greeting = p.firstName ? `Hi ${p.firstName},` : 'Hi there,';
  const link = trackUrl(p.storeBaseUrl, p.orderId);
  const subject = `Your Filament Store order ${p.orderNumber} has been cancelled`;
  const preheader = p.reason
    ? `Cancellation: ${p.reason.slice(0, 70)}`
    : `Your order has been cancelled.`;

  const html = htmlWrapper({
    preheader,
    body: `
      <p style="margin:0 0 16px 0;font-size:16px;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 16px 0;">Your order <strong>${escapeHtml(p.orderNumber)}</strong> has been cancelled. If a payment was taken, the refund is on its way separately.</p>
      ${
        p.reason
          ? `<p style="margin:16px 0;color:#71717a;">Reason: ${escapeHtml(p.reason)}</p>`
          : ''
      }
      <p style="margin:24px 0;">
        <a href="${escapeHtml(link)}" style="display:inline-block;background:#18181b;color:#fafaf7;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">View order status</a>
      </p>
      <p style="margin:0;color:#71717a;font-size:13px;">Need a hand? Reply to this email and we'll sort it.</p>`,
  });

  const text = [
    greeting,
    '',
    `Your order ${p.orderNumber} has been cancelled.`,
    `If a payment was taken, the refund is on its way separately.`,
    p.reason ? `Reason: ${p.reason}` : '',
    '',
    `View order status: ${link}`,
    '',
    `Need a hand? Reply to this email and we'll sort it.`,
    '',
    '— Filament Store',
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, html, text, preheader };
}
