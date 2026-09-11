/**
 * Advert blocks for emails: ranges picked for the customer, and our stores.
 *
 * Email-safe like the rest of the templates: tables, inline styles, no
 * background images, and sharp corners (Outlook ignores border-radius anyway).
 * Columns carry the `stack` class so they sit one above the other on phones
 * whose mail app honours the wrapper's media query.
 */
import { accentFor, SPOOL_COLOURS, storeAdverts, type Recommendation } from '../recommendations';
import { escapeHtml } from './shared';

const absolute = (base: string, path: string) => `${base.replace(/\/+$/, '')}${path}`;

const EYEBROW = 'margin:0 0 6px 0;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;';
const HEADING = 'margin:0 0 18px 0;font-size:22px;line-height:1.25;font-weight:800;color:#15161A;';

/** A strip of spool colours. */
export function spoolStripHtml(height = 6): string {
  const cells = SPOOL_COLOURS.map(
    (c) => `<td height="${height}" style="height:${height}px;line-height:${height}px;font-size:0;background:${c};">&nbsp;</td>`,
  ).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cells}</tr></table>`;
}

export function buttonHtml(
  href: string,
  label: string,
  background: string,
  colour: string,
  opts: { block?: boolean; border?: string } = {},
): string {
  const border = opts.border ? `border:2px solid ${opts.border};` : `border:2px solid ${background};`;
  return `<a href="${escapeHtml(href)}" style="display:${opts.block ? 'block' : 'inline-block'};background:${background};color:${colour};${border}text-align:center;text-decoration:none;font-weight:700;font-size:15px;line-height:1.2;padding:12px 18px;">${escapeHtml(label)}</a>`;
}

/** Side-by-side cells, padded apart. */
function columns(cells: string[]): string {
  const width = Math.floor(100 / cells.length);
  const tds = cells
    .map((cell, i) => {
      const pad = cells.length === 1 ? '0' : i === 0 ? '0 8px 0 0' : i === cells.length - 1 ? '0 0 0 8px' : '0 4px';
      return `<td class="stack stack-gap" width="${width}%" valign="top" style="width:${width}%;padding:${pad};">${cell}</td>`;
    })
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${tds}</tr></table>`;
}

/** "Picked for your next print": a row, or nothing when there are no picks. */
export function recommendationsHtml(recommendations: Recommendation[], storeBaseUrl: string): string {
  if (recommendations.length === 0) return '';
  const cards = recommendations.slice(0, 2).map((r) => {
    const href = absolute(storeBaseUrl, r.path);
    const accent = accentFor(r.material);
    // Only an absolute https image can be shown by a mail client.
    const image =
      r.imageUrl && /^https:\/\//i.test(r.imageUrl)
        ? `<tr><td align="center" style="background:#F5F4F0;"><a href="${escapeHtml(href)}"><img src="${escapeHtml(r.imageUrl)}" width="266" alt="${escapeHtml(r.name)}" style="display:block;width:100%;max-width:266px;height:auto;border:0;" /></a></td></tr>`
        : '';
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;border:1px solid #C7CCD1;">
        <tr><td height="6" style="height:6px;line-height:6px;font-size:0;background:${accent.bar};">&nbsp;</td></tr>
        ${image}
        <tr><td style="padding:16px 16px 18px 16px;">
          <p style="margin:0 0 6px 0;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${accent.ink};">${escapeHtml(r.eyebrow)}</p>
          <p style="margin:0 0 8px 0;font-size:17px;line-height:1.3;font-weight:800;"><a href="${escapeHtml(href)}" style="color:#15161A;text-decoration:none;">${escapeHtml(r.name)}</a></p>
          ${r.blurb ? `<p style="margin:0 0 12px 0;font-size:14px;line-height:1.5;color:#6B6E76;">${escapeHtml(r.blurb)}</p>` : ''}
          ${r.priceFrom ? `<p style="margin:0 0 14px 0;font-size:15px;font-weight:700;color:#15161A;">From ${escapeHtml(r.priceFrom)}</p>` : ''}
          ${buttonHtml(href, 'Shop now →', '#15161A', '#FFFFFF', { block: true })}
        </td></tr>
      </table>`;
  });
  return `<tr><td class="px" style="padding:24px 32px 8px 32px;">
      <p style="${EYEBROW}color:#3B5266;">Picked for your next print</p>
      <h2 style="${HEADING}">You might like these next</h2>
      ${columns(cards)}
    </td></tr>`;
}

/** "Shop our stores": this store and the Clothes Shop, in their own colours. */
export function storesHtml(storeBaseUrl: string): string {
  const cards = storeAdverts(storeBaseUrl).map((s) => {
    const font = s.serif ? "Georgia,'Times New Roman',serif" : 'Arial,Helvetica,sans-serif';
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${s.colours.background};">
        ${s.spoolStrip ? `<tr><td>${spoolStripHtml(5)}</td></tr>` : ''}
        <tr><td style="padding:22px 20px 24px 20px;background:${s.colours.background};">
          <p style="margin:0 0 6px 0;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${s.colours.muted};">${escapeHtml(s.host)}</p>
          <p style="margin:0 0 8px 0;font-size:24px;line-height:1.2;font-weight:800;color:${s.colours.text};font-family:${font};">${escapeHtml(s.name)}</p>
          <p style="margin:0 0 6px 0;font-size:15px;line-height:1.4;font-weight:700;color:${s.colours.text};">${escapeHtml(s.strap)}</p>
          <p style="margin:0 0 18px 0;font-size:13px;line-height:1.5;color:${s.colours.muted};">${escapeHtml(s.detail)}</p>
          ${buttonHtml(s.url, `${s.cta} →`, s.colours.button, s.colours.buttonText)}
        </td></tr>
      </table>`;
  });
  return `<tr><td class="px" style="padding:24px 32px 32px 32px;">
      <p style="${EYEBROW}color:#E8537A;">Shop our stores</p>
      <h2 style="${HEADING}">More from CleverDeals</h2>
      ${columns(cards)}
    </td></tr>`;
}

export function recommendationsText(recommendations: Recommendation[], storeBaseUrl: string): string[] {
  if (recommendations.length === 0) return [];
  return [
    '',
    'PICKED FOR YOUR NEXT PRINT',
    ...recommendations.slice(0, 2).flatMap((r) => [
      '',
      `${r.eyebrow}: ${r.name}${r.priceFrom ? `, from ${r.priceFrom}` : ''}`,
      ...(r.blurb ? [r.blurb] : []),
      absolute(storeBaseUrl, r.path),
    ]),
  ];
}

export function storesText(storeBaseUrl: string): string[] {
  return [
    '',
    'SHOP OUR STORES',
    ...storeAdverts(storeBaseUrl).flatMap((s) => ['', `${s.name}: ${s.strap}`, s.url]),
  ];
}
