/**
 * "Your order is on its way": who it shipped with and the tracking number, a
 * thank-you, and, since a happy customer is the best one to sell to, ranges
 * picked for them and our two stores.
 *
 * The picks are captured into the payload when the email is queued, so what
 * is sent is what was chosen for this customer at dispatch.
 */
import type { Recommendation } from '../recommendations';
import {
  buttonHtml,
  recommendationsHtml,
  recommendationsText,
  spoolStripHtml,
  storesHtml,
  storesText,
} from './adverts';
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
  /** As SMMTA sends it, e.g. "11 September 2026". */
  shippedDate?: string;
  /** Ranges picked for this customer when the email was queued. */
  recommendations?: Recommendation[];
  /** A VAT invoice can be downloaded from the order page. */
  invoiceAvailable?: boolean;
}

export const THANK_YOU =
  'Thanks for your order, we appreciate all of our customers and we hope to see you again soon.';
const REPLY_NOTE = "If anything's not right when it arrives, just reply to this email.";

/** "Your order shipped with DPD and the tracking number is …", as far as we know it. */
function shippedSentence(p: OrderShippedPayload, html: boolean): string {
  const courier = p.courierName
    ? ` with ${html ? `<strong>${escapeHtml(p.courierName)}</strong>` : p.courierName}`
    : '';
  if (!p.trackingNumber) return `Your order shipped${courier}.`;

  let tracking = p.trackingNumber;
  if (html) {
    const chip =
      'background:#F9C74F;color:#15161A;font-weight:700;padding:2px 6px;text-decoration:none;white-space:nowrap;';
    tracking = p.trackingLink
      ? `<a href="${escapeHtml(p.trackingLink)}" style="${chip}">${escapeHtml(p.trackingNumber)}</a>`
      : `<span style="${chip}">${escapeHtml(p.trackingNumber)}</span>`;
  }
  return `Your order shipped${courier} and the tracking number is ${tracking}.`;
}

/** Ordered, packed, shipped: done. Delivered: next. */
function progressHtml(): string {
  const steps: Array<[string, boolean]> = [
    ['Ordered', true],
    ['Packed', true],
    ['Shipped', true],
    ['Delivered', false],
  ];
  const cells = steps
    .map(([label, done], i) => {
      const pad = i === 0 ? '0 3px 0 0' : i === steps.length - 1 ? '0 0 0 3px' : '0 3px';
      return `<td width="25%" valign="top" style="width:25%;padding:${pad};">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="8" style="height:8px;line-height:8px;font-size:0;background:${done ? '#43AA8B' : '#C7CCD1'};">&nbsp;</td></tr></table>
          <p style="margin:8px 0 0 0;font-size:12px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:${done ? '#15161A' : '#6B6E76'};">${done ? '&#10003; ' : ''}${label}</p>
        </td>`;
    })
    .join('');
  return `<tr><td class="px" style="padding:28px 32px 4px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cells}</tr></table></td></tr>`;
}

export function renderOrderShipped(p: OrderShippedPayload): RenderedEmail {
  const name = p.firstName?.trim();
  const statusLink = trackUrl(p.storeBaseUrl, p.orderId);
  const statusLabel = p.invoiceAvailable ? 'Order & VAT invoice' : 'View order status';
  const recommendations = p.recommendations ?? [];

  const subject = `Your Filament Store order ${p.orderNumber} is on its way`;
  const preheader = p.trackingNumber
    ? `Shipped${p.courierName ? ` with ${p.courierName}` : ''}, tracking number ${p.trackingNumber}. Thanks for your order!`
    : `Your order ${p.orderNumber} has shipped. Thanks for your order!`;
  const headline = name ? `Good news, ${name}! Your order is on its way.` : 'Good news! Your order is on its way.';

  const buttons = [
    p.trackingLink ? buttonHtml(p.trackingLink, 'Track your parcel', '#F9C74F', '#15161A') : '',
    buttonHtml(statusLink, statusLabel, '#3B5266', '#FFFFFF', { border: '#FFFFFF' }),
  ]
    .filter(Boolean)
    .map((b) => `<td class="stack" style="padding:0 12px 12px 0;">${b}</td>`)
    .join('');

  const body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td>${spoolStripHtml()}</td></tr>
    <tr><td class="px" style="padding:36px 32px 24px 32px;background:#3B5266;color:#FFFFFF;">
      <p style="margin:0 0 14px 0;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#B4C6D2;">Order ${escapeHtml(p.orderNumber)}${
        p.shippedDate ? ` &middot; Dispatched ${escapeHtml(p.shippedDate)}` : ''
      }</p>
      <p style="margin:0 0 10px 0;font-size:44px;line-height:1;">&#128230;</p>
      <h2 style="margin:0 0 14px 0;font-size:28px;line-height:1.2;font-weight:800;color:#FFFFFF;">${escapeHtml(headline)}</h2>
      <p style="margin:0 0 24px 0;font-size:17px;line-height:1.6;color:#FFFFFF;">${shippedSentence(p, true)}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${buttons}</tr></table>
    </td></tr>
    ${progressHtml()}
    <tr><td class="px" style="padding:24px 32px 8px 32px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="padding:20px 24px;background:#F5F4F0;border-left:6px solid #EF476F;">
          <p style="margin:0 0 8px 0;font-size:20px;font-weight:800;color:#15161A;">Thank you!</p>
          <p style="margin:0;font-size:16px;line-height:1.55;color:#15161A;">${escapeHtml(THANK_YOU)}</p>
          ${
            p.invoiceAvailable
              ? `<p style="margin:12px 0 0 0;font-size:14px;line-height:1.5;color:#15161A;">Your VAT invoice is ready to download from your <a href="${escapeHtml(statusLink)}" style="color:#3B5266;font-weight:700;">order page</a>.</p>`
              : ''
          }
          <p style="margin:12px 0 0 0;font-size:13px;line-height:1.5;color:#6B6E76;">${escapeHtml(REPLY_NOTE)}</p>
        </td></tr>
      </table>
    </td></tr>
    ${recommendationsHtml(recommendations, p.storeBaseUrl)}
    ${storesHtml(p.storeBaseUrl)}
  </table>`;

  const text = [
    name ? `Hi ${name},` : 'Hi there,',
    '',
    `Good news: your order ${p.orderNumber} is on its way.`,
    shippedSentence(p, false),
    ...(p.shippedDate ? [`Dispatched ${p.shippedDate}.`] : []),
    '',
    ...(p.trackingLink ? [`Track your parcel: ${p.trackingLink}`] : []),
    `${p.invoiceAvailable ? 'Your order and VAT invoice' : 'View order status'}: ${statusLink}`,
    '',
    THANK_YOU,
    '',
    REPLY_NOTE,
    ...recommendationsText(recommendations, p.storeBaseUrl),
    ...storesText(p.storeBaseUrl),
    '',
    '— Filament Store',
  ].join('\n');

  return { subject, html: htmlWrapper({ preheader, body, fullBleed: true }), text, preheader };
}
