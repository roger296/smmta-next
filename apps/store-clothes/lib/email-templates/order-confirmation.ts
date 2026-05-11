import type { RenderedEmail } from './index';
import { escapeHtml, htmlWrapper, renderLinesHtml, trackUrl } from './shared';

export interface OrderConfirmationPayload {
  orderId: string;
  orderNumber: string;
  firstName?: string;
  grandTotal: string;
  currency: string; // 'GBP'
  /** Public store origin used to build the tracking link. */
  storeBaseUrl: string;
  lines?: Array<{ name: string; qty: number; lineTotal: string }>;
  shippingAddress?: { line1: string; city: string; postCode: string };
}

export function renderOrderConfirmation(p: OrderConfirmationPayload): RenderedEmail {
  const greeting = p.firstName ? `Hi ${p.firstName},` : 'Hi there,';
  const link = trackUrl(p.storeBaseUrl, p.orderId);
  const subject = `Your Clothes Shop order ${p.orderNumber} is confirmed`;
  const preheader = `Thanks for your order — we're getting it packed for dispatch.`;

  const linesHtml = p.lines && p.lines.length > 0 ? renderLinesHtml(p.lines) : '';
  const linesText =
    p.lines && p.lines.length > 0
      ? '\n' +
        p.lines
          .map((l) => `  - ${l.qty}x ${l.name} — £${l.lineTotal}`)
          .join('\n') +
        '\n'
      : '';
  const addr = p.shippingAddress
    ? `\nShipping to: ${p.shippingAddress.line1}, ${p.shippingAddress.city} ${p.shippingAddress.postCode}\n`
    : '';

  const html = htmlWrapper({
    preheader,
    body: `
      <p style="margin:0 0 16px 0;font-size:16px;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 16px 0;">Thanks for your order. Your reference is <strong>${escapeHtml(p.orderNumber)}</strong>.</p>
      ${linesHtml}
      <p style="margin:16px 0;font-size:16px;"><strong>Total ${escapeHtml(p.currency)} £${escapeHtml(p.grandTotal)}</strong></p>
      ${
        p.shippingAddress
          ? `<p style="margin:16px 0;color:#71717a;">Shipping to ${escapeHtml(p.shippingAddress.line1)}, ${escapeHtml(p.shippingAddress.city)} ${escapeHtml(p.shippingAddress.postCode)}</p>`
          : ''
      }
      <p style="margin:24px 0;">
        <a href="${escapeHtml(link)}" style="display:inline-block;background:#15161A;color:#ECECE8;text-decoration:none;padding:14px 22px;letter-spacing:1.5px;text-transform:uppercase;font-size:13px;font-weight:600;">Track your order</a>
      </p>
      <p style="margin:0;color:#6B6E76;font-size:13px;">We'll email again the moment it ships.</p>`,
  });

  const text = [
    greeting,
    '',
    `Thanks for your order. Your reference is ${p.orderNumber}.`,
    linesText.trim() ? linesText : '',
    `Total ${p.currency} £${p.grandTotal}`,
    addr.trim() ? addr : '',
    `Track your order: ${link}`,
    '',
    `We'll email again as soon as it ships.`,
    '',
    `— Clothes Shop`,
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, html, text, preheader };
}
