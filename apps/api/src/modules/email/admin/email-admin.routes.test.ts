/**
 * The Messaging admin API (runbook section 11), with a signed admin JWT.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../app.js';
import { getEmailSettings, updateEmailSettings } from '../services/settings.service.js';
import { makeContact, makeContacts } from '../testing.js';

let app: FastifyInstance;
let token: string;
let saved: Awaited<ReturnType<typeof getEmailSettings>>;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  token = app.jwt.sign({ userId: 'admin-test', companyId: 'x', email: 'admin@example.com', roles: ['admin'] });
  saved = await getEmailSettings();
});
afterAll(async () => {
  await updateEmailSettings({ marketing_paused: saved.marketing_paused, marketing_paused_reason: saved.marketing_paused_reason, approval_threshold: saved.approval_threshold }, 'test');
  await app.close();
});

const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, body?: unknown) => {
  const res = await app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, ...(body !== undefined ? { payload: body as object } : {}) });
  return { status: res.statusCode, body: res.headers['content-type']?.includes('json') ? res.json() : res.body };
};

describe('Messaging admin API', () => {
  it('refuses without a JWT', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/email/overview' })).statusCode).toBe(401);
  });

  it('overview, contacts, status change with a reason, and the timeline', async () => {
    const o = await call('GET', '/email/overview');
    expect(o.body.data).toMatchObject({ sendMode: expect.any(String), materials: expect.any(Array) });
    const c = await makeContact({ initialStatus: 'all' });
    const list = await call('GET', `/email/contacts?search=${encodeURIComponent(c.email)}`);
    expect(list.body.data.contacts[0].id).toBe(c.id);
    const bad = await call('POST', `/email/contacts/${c.id}/status`, { status: 'never', reason: 'phoned' });
    expect(bad.status).toBe(409);
    const good = await call('POST', `/email/contacts/${c.id}/status`, { status: 'never', reason: 'phoned to ask', confirm: true });
    expect(good.body.data).toMatchObject({ changed: true, to: 'never' });
    const detail = await call('GET', `/email/contacts/${c.id}`);
    expect(detail.body.data.consentEvents[0]).toMatchObject({ source: 'admin_ui', actor: 'admin-test', reason: 'phoned to ask' });
    const csv = await call('GET', `/email/contacts/export.csv?search=${encodeURIComponent(c.email)}`);
    expect(String(csv.body)).toContain(c.email);
  });

  it('import dry run then live run', async () => {
    const c = await makeContact({ initialStatus: 'all' });
    const csvText = `email\n${c.email}\n`;
    const dry = await call('POST', '/email/imports', { csvText, filename: 'u.csv', listType: 'unsubscribes' });
    expect(dry.body.data).toMatchObject({ dryRun: true, would_downgrade: 1 });
    const live = await call('POST', '/email/imports', { csvText, filename: 'u.csv', listType: 'unsubscribes', dryRun: false, dryRunId: dry.body.data.importId });
    expect(live.body.data).toMatchObject({ updated: 1 });
    expect((await call('GET', '/email/imports')).body.data.length).toBeGreaterThan(0);
  });

  it('campaign: create, preview, segment count, schedule, cancel; approval by a person', async () => {
    const people = await makeContacts(3);
    const seg = { contact_ids: people.map((p) => p.id) };
    expect((await call('POST', '/email/segments/preview', { segment: seg })).body.data.count).toBe(3);
    const created = await call('POST', '/email/campaigns', { name: 'Admin test', subject: 'Hello', segment: seg, content: [{ type: 'Text', props: { body: 'Hi' } }] });
    expect(created.body.data.status).toBe('draft');
    const id = created.body.data.id;
    const prev = await call('GET', `/email/campaigns/${id}/preview`);
    expect(prev.body.data).toHaveLength(3);
    expect((await call('POST', `/email/campaigns/${id}/test-send`, { emails: ['stranger@example.com'] })).status).toBe(400);
    expect((await call('POST', `/email/campaigns/${id}/schedule`, {})).body.data.status).toBe('scheduled');
    expect((await call('GET', `/email/campaigns/${id}`)).body.data.report.total).toBe(0);
    expect((await call('POST', `/email/campaigns/${id}/approve`, {})).status).toBe(409);
    expect((await call('POST', `/email/campaigns/${id}/cancel`, {})).body.data.status).toBe('cancelled');
  });

  it('automations, templates, weekly content, deliverability pause, settings validation', async () => {
    expect((await call('GET', '/email/automations')).body.data.length).toBeGreaterThan(5);
    expect((await call('PATCH', '/email/automations/welcome', { enabled: false })).body.data.enabled).toBe(false);
    const t = await call('GET', '/email/templates');
    expect(t.body.data.find((x: { key: string }) => x.key === 'back_in_stock')).toBeDefined();
    expect((await call('GET', '/email/templates/back_in_stock/preview')).body.data.subject).toMatch(/^It's back/);
    const w = await call('POST', '/email/weekly-content', { key: 'material:pla', kind: 'featured', body: 'Dry your PLA.', week: '2032-01-05' });
    expect(w.body.data.weekStart).toBe('2032-01-05');
    expect((await call('POST', '/email/deliverability/pause', { reason: 'testing' })).body.data.marketingPaused).toBe(true);
    expect((await call('GET', '/email/deliverability')).body.data.marketingPaused).toBe(true);
    expect((await call('POST', '/email/deliverability/resume', {})).body.data.marketingPaused).toBe(false);
    expect((await call('PUT', '/email/settings', { approval_threshold: 'lots' })).status).toBe(400);
    expect((await call('PUT', '/email/settings', { approval_threshold: 50 })).body.data.approval_threshold).toBe(50);
    expect((await call('GET', '/email/audit')).body.data.length).toBeGreaterThan(0);
  });
});
