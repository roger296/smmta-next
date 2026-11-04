/**
 * Public unsubscribe and preferences pages, through the real app.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../app.js';
import { getDb } from '../../../config/database.js';
import { emailConsentEvents } from '../../../db/schema/index.js';
import { ContactsService } from '../services/contacts.service.js';
import { makeContact } from '../testing.js';
import { publicPageLimiter } from './public.routes.js';

let app: FastifyInstance;
const contacts = new ContactsService();
const form = { 'content-type': 'application/x-www-form-urlencoded' };

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});
afterAll(() => app.close());
beforeEach(() => publicPageLimiter.reset());

const events = (id: string) =>
  getDb().select().from(emailConsentEvents).where(eq(emailConsentEvents.contactId, id)).orderBy(emailConsentEvents.createdAt);

describe('one-click unsubscribe', () => {
  it('flips the contact, records the IP, answers 200 with no body, and a second POST is a no-op', async () => {
    const c = await makeContact({ initialStatus: 'all' });
    const res = await app.inject({
      method: 'POST',
      url: `/email/u/${c.unsubscribeToken}`,
      headers: { ...form, 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    expect((await contacts.get(c.id))!.marketingStatus).toBe('transactional_only');
    const ev = await events(c.id);
    expect(ev).toHaveLength(2);
    expect(ev[1]).toMatchObject({ source: 'one_click', ip: '203.0.113.9', toStatus: 'transactional_only' });

    const again = await app.inject({ method: 'POST', url: `/email/u/${c.unsubscribeToken}`, headers: form, payload: 'List-Unsubscribe=One-Click' });
    expect(again.statusCode).toBe(200);
    expect(await events(c.id)).toHaveLength(2);
  });

  it('answers 200 to an unknown token and writes nothing', async () => {
    const res = await app.inject({ method: 'POST', url: '/email/u/not-a-real-token', headers: form, payload: 'List-Unsubscribe=One-Click' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  it('works through the /api prefix too', async () => {
    const c = await makeContact({ initialStatus: 'all' });
    const res = await app.inject({ method: 'POST', url: `/api/email/u/${c.unsubscribeToken}`, headers: form, payload: 'List-Unsubscribe=One-Click' });
    expect(res.statusCode).toBe(200);
    expect((await contacts.get(c.id))!.marketingStatus).toBe('transactional_only');
  });

  it('rate-limits a single IP to 30 a minute', async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) {
      const r = await app.inject({ method: 'POST', url: '/email/u/x', headers: { ...form, 'x-forwarded-for': '198.51.100.7' }, payload: 'List-Unsubscribe=One-Click' });
      last = r.statusCode;
    }
    expect(last).toBe(429);
  });
});

describe('unsubscribe page', () => {
  it('renders a confirmation page that masks the address and is not indexed', async () => {
    const c = await makeContact({ initialStatus: 'all' });
    const res = await app.inject({ method: 'GET', url: `/email/u/${c.unsubscribeToken}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['x-robots-tag']).toMatch(/noindex/);
    expect(res.body).toContain('Unsubscribe from marketing emails?');
    expect(res.body).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(res.body).not.toContain(c.email);
    expect(res.body).not.toContain('<script');
    expect(res.body).toContain(`action="/email/u/${c.unsubscribeToken}"`);
  });

  it('confirms with confirm=1 and says what they will still receive', async () => {
    const c = await makeContact({ initialStatus: 'all' });
    const res = await app.inject({ method: 'POST', url: `/email/u/${c.unsubscribeToken}`, headers: form, payload: 'confirm=1' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('You are unsubscribed');
    expect(res.body).toContain('dispatch and delivery updates');
    expect((await contacts.get(c.id))!.marketingStatus).toBe('transactional_only');
    expect((await events(c.id)).at(-1)!.source).toBe('link');
  });

  it('tells a never-email contact they are already unsubscribed, with no button', async () => {
    const c = await makeContact({ initialStatus: 'never' });
    const res = await app.inject({ method: 'GET', url: `/email/u/${c.unsubscribeToken}` });
    expect(res.body).toContain('You are already unsubscribed');
    expect(res.body).not.toContain('<button');
  });
});

describe('preferences page', () => {
  it('round-trips interests and switches', async () => {
    const c = await makeContact({ initialStatus: 'all' });
    const url = `/email/preferences/${c.unsubscribeToken}`;
    const get = await app.inject({ method: 'GET', url });
    expect(get.statusCode).toBe(200);
    expect(get.body).toContain('value="material:pla"');

    const res = await app.inject({
      method: 'POST',
      url,
      headers: form,
      payload: 'marketing=1&digest=1&interest=material%3Apla&interest=material%3Apetg',
    });
    expect(res.body).toContain('Saved.');
    const after = (await contacts.get(c.id))!;
    expect(after.marketingStatus).toBe('all');
    expect(after.digestEnabled).toBe(true);
    expect(after.newProductAlertsEnabled).toBe(false);
    expect(Object.keys(after.interests).sort()).toEqual(['material:petg', 'material:pla']);
    expect(res.body).toMatch(/value="material:pla" checked/);
    expect(res.body).not.toMatch(/value="material:abs" checked/);
  });

  it('treats unticking everything as an unsubscribe', async () => {
    const c = await makeContact({ initialStatus: 'all' });
    await app.inject({ method: 'POST', url: `/email/preferences/${c.unsubscribeToken}`, headers: form, payload: '' });
    expect((await contacts.get(c.id))!.marketingStatus).toBe('transactional_only');
    expect((await events(c.id)).at(-1)!.source).toBe('preferences_page');
  });

  it('re-subscribes from transactional_only with the form as evidence', async () => {
    const c = await makeContact({ initialStatus: 'transactional_only' });
    await app.inject({
      method: 'POST',
      url: `/email/preferences/${c.unsubscribeToken}`,
      headers: { ...form, 'user-agent': 'TestBrowser/1.0' },
      payload: 'marketing=1&new_products=1',
    });
    const after = (await contacts.get(c.id))!;
    expect(after.marketingStatus).toBe('all');
    expect(after.consentSource).toBe('preferences_page');
    const last = (await events(c.id)).at(-1)!;
    expect(last).toMatchObject({ source: 'preferences_page', toStatus: 'all', userAgent: 'TestBrowser/1.0' });
  });

  it('shows no form to a never-email contact and changes nothing on POST', async () => {
    const c = await makeContact({ initialStatus: 'never' });
    const url = `/email/preferences/${c.unsubscribeToken}`;
    const get = await app.inject({ method: 'GET', url });
    expect(get.body).not.toContain('<form');
    await app.inject({ method: 'POST', url, headers: form, payload: 'marketing=1&digest=1' });
    expect((await contacts.get(c.id))!.marketingStatus).toBe('never');
  });

  it('404s an unknown token without saying more', async () => {
    const res = await app.inject({ method: 'GET', url: '/email/preferences/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('This link has expired');
  });
});
