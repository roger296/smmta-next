/**
 * Templates (runbook section 7): a snapshot of every template's HTML and
 * text, the link rules, the footer, and the HTML lint every email must pass.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderForSamples, renderTemplate, type RenderedEmail } from './render.js';
import { TEMPLATE_KEYS, TEMPLATES, fillSubject } from './registry.js';
import { SAMPLE_DATA } from './fixtures.js';
import { COMPANY } from './company.js';
import { OFFER_BLOCKS } from './blocks.js';
import { verifySignedLink } from '../lib/tokens.js';

const contact = { id: '22222222-0000-4000-8000-000000000001', unsubscribeToken: 'TOKEN_abc', isTrade: false };
const rendered: Record<string, RenderedEmail> = {};

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-05T10:00:00Z'));
  for (const key of TEMPLATE_KEYS) {
    rendered[key] = await renderTemplate({ templateKey: key, kind: key, data: SAMPLE_DATA[key] ?? {}, contact, sendId: '33333333-0000-4000-8000-000000000001', firstName: 'Ada' });
  }
});
afterAll(() => vi.useRealTimers());

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, '&'));

describe.each(TEMPLATE_KEYS)('template %s', (key) => {
  it('matches its snapshot (subject, html, text)', () => {
    const r = rendered[key]!;
    expect(r.subject).toMatchSnapshot('subject');
    expect(r.html).toMatchSnapshot('html');
    expect(r.text).toMatchSnapshot('text');
  });

  it('passes the email lint', () => {
    const { html } = rendered[key]!;
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
    expect(html).not.toMatch(/<script/i);
    expect(html.toLowerCase()).not.toContain('sendgrid.net');
    for (const img of html.match(/<img[^>]*>/g) ?? []) {
      expect(img).toMatch(/alt="[^"]+"/);
      const w = img.match(/width="(\d+)"/);
      if (w) expect(Number(w[1])).toBeLessThanOrEqual(600);
    }
    expect(Buffer.byteLength(html)).toBeLessThan(100 * 1024);
    expect(html).toContain('max-width:600px');
  });

  it('tags every shop link with UTM and the send id, except the unsubscribe pages', () => {
    const { html } = rendered[key]!;
    const cls = TEMPLATES[key]!.class;
    for (const href of hrefs(html)) {
      const u = new URL(href.startsWith('mailto:') ? 'mailto:x@example.com' : href);
      if (u.host !== 'filament.cleverdeals.net') continue;
      if (u.pathname.startsWith('/email/')) {
        expect(u.searchParams.get('utm_source')).toBeNull();
        continue;
      }
      expect(u.searchParams.get('utm_source')).toBe('email');
      expect(u.searchParams.get('utm_medium')).toBe(cls);
      expect(u.searchParams.get('utm_campaign')).toBe(key);
      expect(u.searchParams.get('eid')).toBe('33333333-0000-4000-8000-000000000001');
    }
  });

  it('shows unsubscribe links on marketing only', () => {
    const { html } = rendered[key]!;
    const marketing = TEMPLATES[key]!.class === 'marketing';
    expect(html.includes('/email/u/TOKEN_abc')).toBe(marketing);
    expect(html.includes('/email/preferences/TOKEN_abc')).toBe(marketing);
    if (marketing) expect(html).toMatch(/clicktracking="off" href="https:\/\/filament\.cleverdeals\.net\/email\/u\/TOKEN_abc"/);
  });

  it('carries the trader details and a reason in the footer', () => {
    const { html } = rendered[key]!;
    for (const v of [COMPANY.legalEntity, COMPANY.companyNumber, COMPANY.registeredAddress]) expect(html).toContain(v);
    expect(html).toContain(TEMPLATES[key]!.why.replace(/'/g, '&#x27;'));
  });

  it('keeps offers out of service mail', () => {
    if (TEMPLATES[key]!.class !== 'service') return;
    const blocks = SAMPLE_DATA[key]?.blocks ?? [];
    for (const b of blocks) expect(OFFER_BLOCKS).not.toContain(b.type);
  });
});

describe('links', () => {
  it('product links carry their interest keys, and add-to-cart links are signed for the exact variant', () => {
    const links = hrefs(rendered.weekly_digest!.html);
    const view = links.find((h) => h.includes('/shop/landu-pla-basic'))!;
    expect(new URL(view).searchParams.get('ik')).toBe('material:pla');
    expect(new URL(view).searchParams.get('colour')).toBe('galaxy black');
    const add = links.find((h) => h.includes('/cart/add'))!;
    const payload = verifySignedLink<{ p: string; q: number; c: string }>(new URL(add).searchParams.get('t')!);
    expect(payload).toMatchObject({ p: '11111111-0000-4000-8000-000000000001', q: 1, c: contact.id });
  });

  it('leaves links to other sites alone', async () => {
    const r = await renderTemplate({ templateKey: 'manual', kind: 'manual', data: { blocks: [{ type: 'FeaturedText', props: { markdown: 'See [the maker](https://www.landu.example.org/about).' } }] }, contact, sendId: 's' });
    expect(hrefs(r.html)).toContain('https://www.landu.example.org/about');
  });
});

describe('subjects', () => {
  it('fills first names with a fallback', () => {
    expect(fillSubject('Hi {{first_name|there}}, new PLA', 'Ada')).toBe('Hi Ada, new PLA');
    expect(fillSubject('Hi {{first_name|there}}, new PLA', null)).toBe('Hi there, new PLA');
    expect(fillSubject('{{ first_name }} — news', '')).toBe(' — news');
  });
  it('a roll-up back-in-stock email names the count', async () => {
    const two = { items: [...SAMPLE_DATA.back_in_stock!.items!, { ...SAMPLE_DATA.back_in_stock!.items![0]!, productId: 'x2', productName: 'Landu PETG Pro' }] };
    const r = await renderTemplate({ templateKey: 'back_in_stock', kind: 'back_in_stock', data: two, contact, sendId: 's' });
    expect(r.subject).toBe('2 things you asked about are back in stock');
  });
});

describe('trade contacts', () => {
  it('see a trade price only when one is given', async () => {
    const r = await renderTemplate({ templateKey: 'weekly_digest', kind: 'weekly_digest', data: SAMPLE_DATA.weekly_digest!, contact: { ...contact, isTrade: true }, sendId: 's' });
    expect(r.html).toContain('Your trade price: £14.50');
    expect(rendered.weekly_digest!.html).not.toContain('trade price');
  });
});

describe('footer details', () => {
  it('match the storefront legal page values', () => {
    const legal = readFileSync(resolve(process.cwd(), '../store/lib/legal.ts'), 'utf8');
    for (const v of [COMPANY.legalEntity, COMPANY.companyNumber, COMPANY.registeredAddress, COMPANY.vatNumber, COMPANY.contactEmail]) {
      expect(legal).toContain(`'${v}'`);
    }
  });
});

describe('renderForSamples', () => {
  it('returns three previews for every template key', async () => {
    for (const key of TEMPLATE_KEYS) {
      const def = TEMPLATES[key]!;
      const previews = await renderForSamples({ id: 'preview', templateKey: key, class: def.class, kind: key, subject: '', preheader: null, content: SAMPLE_DATA[key]?.blocks ?? [], utmCampaign: null });
      expect(previews.map((p) => p.label)).toEqual(['with interests', 'trade', 'new']);
      for (const p of previews) expect(p.html.length).toBeGreaterThan(500);
    }
  });
});
