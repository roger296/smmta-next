import type { RenderedEmail } from './index';
import { escapeHtml, htmlWrapper } from './shared';

export interface BackInStockPayload {
  /** Public store origin used to build the PDP link. */
  storeBaseUrl: string;
  /** Product display name as shown on the PDP. */
  productName: string;
  /** Group slug — the canonical PDP URL is /shop/<slug>. */
  productSlug: string | null;
  /** Hero image URL; rendered inline in the email. Optional. */
  productImageUrl: string | null;
  /** Decimal string in major units, e.g. "24.00". */
  priceGbp: string | null;
  /** Variant colour, used for the deep-link `?colour=` and the body copy. */
  colour: string | null;
}

function pdpUrl(p: BackInStockPayload): string {
  const base = p.storeBaseUrl.replace(/\/$/, '');
  if (!p.productSlug) return `${base}/shop`;
  const url = `${base}/shop/${encodeURIComponent(p.productSlug)}`;
  return p.colour ? `${url}?colour=${encodeURIComponent(p.colour.toLowerCase())}` : url;
}

export function renderBackInStock(p: BackInStockPayload): RenderedEmail {
  const colourPart = p.colour ? ` in ${p.colour}` : '';
  const subject = `It's back: ${p.productName}${colourPart}`;
  const preheader = `Your ${p.productName}${colourPart} is back in stock.`;
  const link = pdpUrl(p);

  const priceLine = p.priceGbp
    ? `<p style="margin:0 0 16px 0;font-size:16px;"><strong>£${escapeHtml(p.priceGbp)}</strong> per spool · inc. VAT</p>`
    : '';
  const priceText = p.priceGbp ? `£${p.priceGbp} per spool (inc. VAT)\n` : '';

  const imageBlock = p.productImageUrl
    ? `<p style="margin:0 0 20px 0;"><img src="${escapeHtml(p.productImageUrl)}" alt="${escapeHtml(p.productName)}" width="280" style="display:block;border:1px solid #C7CCD1;max-width:100%;height:auto;" /></p>`
    : '';

  const html = htmlWrapper({
    preheader,
    body: `
      <p style="margin:0 0 12px 0;font-size:18px;font-weight:700;letter-spacing:-0.4px;">It's back in stock.</p>
      <p style="margin:0 0 20px 0;font-size:15px;">
        <strong>${escapeHtml(p.productName)}</strong>${escapeHtml(colourPart)} is available again — limited stock, so don't hang about.
      </p>
      ${imageBlock}
      ${priceLine}
      <p style="margin:24px 0;">
        <a href="${escapeHtml(link)}" style="display:inline-block;background:#15161A;color:#ECECE8;text-decoration:none;padding:14px 22px;letter-spacing:1.5px;text-transform:uppercase;font-size:13px;font-weight:600;">View &amp; buy now</a>
      </p>
      <p style="margin:24px 0 0 0;color:#6B6E76;font-size:13px;">
        You're receiving this because you asked to be notified when this item came back in stock. We'll only send one email per request.
      </p>`,
  });

  const text = [
    `It's back in stock.`,
    ``,
    `${p.productName}${colourPart} is available again.`,
    priceText.trim() ? priceText : '',
    `View and buy now: ${link}`,
    ``,
    `You're receiving this because you asked to be notified when this item came back in stock. We'll only send one email per request.`,
  ]
    .filter((line) => line !== '')
    .join('\n');

  return { subject, html, text, preheader };
}
