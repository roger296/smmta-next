import type { RenderedEmail } from './index';
import { escapeHtml, htmlWrapper, trackUrl } from './shared';

export interface OrderShippedPayload {
  orderId: string;
  orderNumber: string;
  firstName?: string;
  storeBaseUrl: string;
  courierName?: string;
  trackingNumber?: string;
  trackingLink?: string;
  shippedDate?: string; // ISO or YYYY-MM-DD
}

export function renderOrderShipped(p: OrderShippedPayload): RenderedEmail {
  const greeting = p.firstName ? `Hi ${p.firstName},` : 'Hi there,';
  const link = trackUrl(p.storeBaseUrl, p.orderId);
  const subject = `Your Filament Store order ${p.orderNumber} is on its way`;
  const preheader = p.courierName
    ? `Out for delivery via ${p.courierName}.`
    : `Out for delivery.`;

  const trackingHtml = p.trackingNumber
    ? `<p style="margin:16px 0;">Tracking number: <strong>${escapeHtml(p.trackingNumber)}</strong>${
        p.courierName ? ` (${escapeHtml(p.courierName)})` : ''
      }${
        p.trackingLink
          ? ` — <a href="${escapeHtml(p.trackingLink)}" style="color:#b45309;">track with the courier</a>`
          : ''
      }.</p>`
    : '';

  const html = htmlWrapper({
    preheader,
    body: `
      <p style="margin:0 0 16px 0;font-size:16px;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 16px 0;">Your order <strong>${escapeHtml(p.orderNumber)}</strong> has shipped from the workshop${
        p.shippedDate ? ` on ${escapeHtml(p.shippedDate)}` : ''
      }.</p>
      ${trackingHtml}
      <p style="margin:24px 0;">
        <a href="${escapeHtml(link)}" style="display:inline-block;background:#18181b;color:#fafaf7;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">View order status</a>
      </p>
      <p style="margin:0;color:#71717a;font-size:13px;">If anything's not right when it arrives, just reply to this email.</p>`,
  });

  const text = [
    greeting,
    '',
    `Your order ${p.orderNumber} has shipped${p.shippedDate ? ` on ${p.shippedDate}` : ''}.`,
    p.trackingNumber
      ? `Tracking number: ${p.trackingNumber}${p.courierName ? ` (${p.courierName})` : ''}.${
          p.trackingLink ? ` Tracking link: ${p.trackingLink}` : ''
        }`
      : '',
    '',
    `View order status: ${link}`,
    '',
    `If anything's not right when it arrives, just reply to this email.`,
    '',
    '— Filament Store',
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, html, text, preheader };
}
