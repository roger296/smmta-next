import type { RenderedEmail } from './index';
import { escapeHtml, htmlWrapper, trackUrl } from './shared';

export interface RefundIssuedPayload {
  orderId: string;
  orderNumber: string;
  firstName?: string;
  storeBaseUrl: string;
  refundAmount: string; // major-unit decimal
  currency: string; // 'GBP'
  /** Mollie's `re_xxx` id, surfaced for the customer's records. */
  refundId?: string;
}

export function renderRefundIssued(p: RefundIssuedPayload): RenderedEmail {
  const greeting = p.firstName ? `Hi ${p.firstName},` : 'Hi there,';
  const link = trackUrl(p.storeBaseUrl, p.orderId);
  const subject = `Refund issued for Filament Store order ${p.orderNumber}`;
  const preheader = `£${p.refundAmount} on its way back to your card.`;

  const html = htmlWrapper({
    preheader,
    body: `
      <p style="margin:0 0 16px 0;font-size:16px;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 16px 0;">We've issued a refund of <strong>${escapeHtml(p.currency)} £${escapeHtml(p.refundAmount)}</strong> against order <strong>${escapeHtml(p.orderNumber)}</strong>.</p>
      <p style="margin:0 0 16px 0;color:#71717a;">It can take 3–5 working days to land back on your card, depending on your bank.</p>
      ${
        p.refundId
          ? `<p style="margin:16px 0;color:#71717a;">Refund reference: <code style="font-family:monospace;">${escapeHtml(p.refundId)}</code></p>`
          : ''
      }
      <p style="margin:24px 0;">
        <a href="${escapeHtml(link)}" style="display:inline-block;background:#18181b;color:#fafaf7;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">View order status</a>
      </p>
      <p style="margin:0;color:#71717a;font-size:13px;">If you have any questions, just reply to this email.</p>`,
  });

  const text = [
    greeting,
    '',
    `We've issued a refund of ${p.currency} £${p.refundAmount} against order ${p.orderNumber}.`,
    `It can take 3–5 working days to land back on your card, depending on your bank.`,
    p.refundId ? `Refund reference: ${p.refundId}` : '',
    '',
    `View order status: ${link}`,
    '',
    `If you have any questions, just reply to this email.`,
    '',
    '— Filament Store',
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, html, text, preheader };
}
