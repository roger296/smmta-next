/**
 * Shared rendering primitives. The HTML wrapper is deliberately
 * conservative — table-based layout, inline styles, no web fonts —
 * because that's what holds up across Gmail / Outlook / Apple Mail
 * without a CSS reset.
 */

const BRAND_NAME = 'Filament Store';

export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export interface WrapperInput {
  preheader: string;
  body: string; // HTML, already escaped where needed
}

/** Email-safe HTML wrapper with the preheader trick (hidden span first). */
export function htmlWrapper({ preheader, body }: WrapperInput): string {
  const safePre = escapeHtml(preheader);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width" />
    <title>${escapeHtml(BRAND_NAME)}</title>
  </head>
  <body style="margin:0;padding:0;background:#fafaf7;color:#18181b;font-family:Arial,Helvetica,sans-serif;">
    <span style="display:none !important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;">
      ${safePre}
    </span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border:1px solid #e4e4e7;border-radius:8px;">
            <tr>
              <td style="padding:24px 32px;border-bottom:1px solid #e4e4e7;">
                <h1 style="margin:0;font-size:20px;font-weight:600;color:#18181b;">${escapeHtml(BRAND_NAME)}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;font-size:15px;line-height:1.55;color:#18181b;">
                ${body}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px;border-top:1px solid #e4e4e7;color:#71717a;font-size:12px;">
                © ${new Date().getFullYear()} ${escapeHtml(BRAND_NAME)} · Hand-finished LED filament lighting.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** Render a list of `{ name, qty, unit, lineTotal }` lines as an
 *  email-safe HTML table. */
export function renderLinesHtml(
  lines: Array<{ name: string; qty: number; lineTotal: string; currency?: string }>,
): string {
  const rows = lines
    .map(
      (l) => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #e4e4e7;">${escapeHtml(l.name)}</td>
          <td style="padding:8px 0;border-bottom:1px solid #e4e4e7;text-align:right;">${l.qty}</td>
          <td style="padding:8px 0;border-bottom:1px solid #e4e4e7;text-align:right;">${escapeHtml((l.currency ?? '£') + l.lineTotal)}</td>
        </tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0;">
    <thead>
      <tr>
        <th align="left" style="padding-bottom:6px;font-size:12px;text-transform:uppercase;color:#71717a;">Item</th>
        <th align="right" style="padding-bottom:6px;font-size:12px;text-transform:uppercase;color:#71717a;">Qty</th>
        <th align="right" style="padding-bottom:6px;font-size:12px;text-transform:uppercase;color:#71717a;">Total</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/** Build a tracking link in plain text + HTML. Caller passes the base URL
 *  (so we don't import the env loader inside templates). */
export function trackUrl(storeBaseUrl: string, orderId: string): string {
  return `${storeBaseUrl.replace(/\/$/, '')}/track/${encodeURIComponent(orderId)}`;
}
