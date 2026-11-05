/**
 * The MCP tools through a real MCP client (in-memory transport), the HTTP
 * endpoint, and the docs/email/MCP.md list kept in step with the registry.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildApp } from '../../../app.js';
import { getDb } from '../../../config/database.js';
import { emailAudit } from '../../../db/schema/index.js';
import { buildMcpServer } from './server.js';
import { EMAIL_TOOLS } from './tools.js';
import { cleanupFixtures, makeApiKey, makeContact, makeContacts, setEnvAllowlist, withSettings } from '../testing.js';
import { setTransportForTests } from '../services/sender.service.js';

async function client(ctx = { actor: 'claude', canApprove: false }) {
  const server = buildMcpServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(b);
  return c;
}

const text = (r: any) => (r.content?.[0]?.text as string) ?? '';
const json = (r: any) => JSON.parse(text(r));
let restore: Array<() => unknown> = [];

afterAll(async () => {
  for (const r of restore) await r();
  setTransportForTests(undefined);
  await cleanupFixtures();
});

describe('the tool list', () => {
  it('matches docs/email/MCP.md', async () => {
    const doc = readFileSync(resolve(process.cwd(), '../../docs/email/MCP.md'), 'utf8');
    const documented = [...doc.matchAll(/^\| `(email_[a-z_]+)` \|/gm)].map((m) => m[1]).sort();
    const c = await client();
    const listed = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(listed).toEqual(EMAIL_TOOLS.map((t) => t.name).sort());
    expect(documented).toEqual(listed);
  });

  it('every tool says what it does, and guarded tools say how', async () => {
    const c = await client();
    const tools = (await c.listTools()).tools;
    for (const t of tools) expect(t.description!.length).toBeGreaterThan(30);
    expect(tools.find((t) => t.name === 'email_schedule_campaign')!.description).toMatch(/pending_approval/);
    expect(tools.find((t) => t.name === 'email_approve_campaign')!.description).toMatch(/email:approve/);
    expect(tools.find((t) => t.name === 'email_send_test')!.description).toMatch(/ALLOWLIST/);
  });
});

describe('calling every tool', () => {
  it('each returns its shape, invalid arguments are refused, and every call is audited', async () => {
    const c = await client();
    const contact = await makeContact({ initialStatus: 'all' });
    const auditCount = async () => (await getDb().select({ id: emailAudit.id }).from(emailAudit)).length;
    const before = await auditCount();
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await c.callTool({ name, arguments: args });
      if (r.isError) throw new Error(`${name}: ${text(r)}`);
      return json(r);
    };

    expect((await call('email_list_contacts', { search: contact.email })).contacts[0].id).toBe(contact.id);
    expect((await call('email_get_contact', { email: contact.email })).contact.id).toBe(contact.id);
    expect(await call('email_set_marketing_status', { contact_id: contact.id, status: 'transactional_only', reason: 'asked on the phone' })).toMatchObject({ changed: true });
    const imp = await call('email_import_csv', { list_type: 'unsubscribes', csv: `email\n${contact.email}\n` });
    expect(imp).toMatchObject({ dryRun: true, rows_read: 1 });
    expect((await call('email_get_import', { id: imp.importId })).id).toBe(imp.importId);
    expect(await call('email_preview_segment', { segment: { contact_ids: [contact.id] } })).toMatchObject({ count: 0 });
    const camp = await call('email_create_campaign', { name: 'MCP test', subject: 'Hello', segment: { contact_ids: [contact.id] }, content: [{ type: 'Text', props: { body: 'Hi' } }] });
    expect(camp).toMatchObject({ status: 'draft', createdBy: 'claude' });
    expect((await call('email_update_campaign', { id: camp.id, subject: 'Hello again' })).subject).toBe('Hello again');
    const previews = await call('email_render_preview', { id: camp.id });
    expect(previews.map((p: { label: string }) => p.label)).toEqual(['with interests', 'trade', 'new']);
    const undo = setEnvAllowlist('owner@example.com');
    restore.push(undo);
    setTransportForTests(undefined);
    const sent: unknown[] = [];
    const { OperatorService } = await import('../services/operator.service.js');
    const op = new OperatorService();
    expect((await op.sendTest(camp.id, ['owner@example.com'], 'claude', { send: async (p) => { sent.push(p); return { messageId: 'm1' }; } })).sent).toHaveLength(1);
    expect((sent[0] as any).subject).toMatch(/^\[TEST\]/);
    expect((sent[0] as any).mail_settings.sandbox_mode.enable).toBe(true);
    expect(await call('email_schedule_campaign', { id: camp.id })).toMatchObject({ status: 'scheduled' });
    expect((await call('email_get_campaign_report', { id: camp.id })).report.total).toBe(0);
    expect(Array.isArray(await call('email_get_campaign_report', {}))).toBe(true);
    expect(await call('email_cancel_campaign', { id: camp.id })).toMatchObject({ status: 'cancelled' });
    const autos = await call('email_list_automations');
    expect(autos.map((a: { key: string }) => a.key)).toContain('replenishment');
    expect(await call('email_update_automation', { key: 'welcome', settings: { enabled: false } })).toMatchObject({ key: 'welcome', enabled: false });
    expect(await call('email_get_deliverability')).toHaveProperty('rates7');
    const s = await call('email_get_settings');
    restore.push(await withSettings({ marketing_paused: s.marketing_paused, marketing_paused_reason: s.marketing_paused_reason, approval_threshold: s.approval_threshold }));
    expect(await call('email_pause_marketing', { reason: 'testing the switch' })).toMatchObject({ marketingPaused: true });
    expect(await call('email_resume_marketing')).toMatchObject({ marketingPaused: false });
    expect((await call('email_update_settings', { settings: { approval_threshold: 50 } })).approval_threshold).toBe(50);
    const rc = await call('email_record_consent', { email: `rc-${Date.now()}@example.com`, source: 'trade show', evidence: 'signed the sheet at the stand' });
    expect(rc).toMatchObject({ to: 'all' });
    expect(await call('email_write_weekly_content', { key: 'material:pla', body: 'Dry your PLA.', week: '2031-01-06' })).toMatchObject({ kind: 'featured', key: 'material:pla' });

    // The send-test, pause/resume and resume-campaign paths not called above.
    const paused = await call('email_create_campaign', { name: 'MCP pause', subject: 'x', segment: { contact_ids: [contact.id] } });
    await expect(call('email_pause_campaign', { id: paused.id })).rejects.toThrow(/cannot go from draft/);
    await expect(call('email_resume_campaign', { id: paused.id })).rejects.toThrow(/cannot go from draft/);
    await expect(call('email_send_test', { id: paused.id, emails: ['stranger@example.com'] })).rejects.toThrow(/not on the test allowlist/);
    await expect(call('email_approve_campaign', { id: paused.id })).rejects.toThrow(/approval needs a person/);

    // Invalid arguments are refused by the schema.
    const bad = await c.callTool({ name: 'email_set_marketing_status', arguments: { contact_id: 'not-a-uuid', status: 'maybe' } });
    expect(bad.isError).toBe(true);

    expect((await auditCount()) - before).toBeGreaterThanOrEqual(EMAIL_TOOLS.length - 1);
    const [last] = await getDb().select().from(emailAudit).orderBy(desc(emailAudit.createdAt)).limit(1);
    expect(last!.actor).toBe('claude');
    const rec = await getDb().select().from(emailAudit).where(eq(emailAudit.tool, 'email_record_consent')).orderBy(desc(emailAudit.createdAt)).limit(1);
    expect(JSON.stringify(rec[0]!.args)).toContain('***@example.com');
  });

  it('a Claude campaign to 51 contacts goes to pending_approval', async () => {
    const c = await client();
    const many = await makeContacts(51);
    const r = await c.callTool({ name: 'email_create_campaign', arguments: { name: 'Big', subject: 'Hi', segment: { contact_ids: many.map((m) => m.id) } } });
    const camp = json(r);
    const s = await c.callTool({ name: 'email_schedule_campaign', arguments: { id: camp.id } });
    expect(json(s).status).toBe('pending_approval');
    const roger = await client({ actor: 'mcp:abcd1234', canApprove: true });
    const a = await roger.callTool({ name: 'email_approve_campaign', arguments: { id: camp.id } });
    expect(json(a)).toMatchObject({ status: 'scheduled', approvedBy: 'mcp:abcd1234' });
    await c.callTool({ name: 'email_cancel_campaign', arguments: { id: camp.id } });
  });
});

describe('POST /api/mcp', () => {
  let app: FastifyInstance;
  let key: Awaited<ReturnType<typeof makeApiKey>>;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    key = await makeApiKey(['email:mcp']);
  });
  afterAll(async () => {
    await key.remove();
    await app.close();
  });

  const rpc = (body: unknown, auth = true) =>
    app.inject({
      method: 'POST',
      url: '/api/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth ? { authorization: `Bearer ${key.raw}` } : {}) },
      payload: JSON.stringify(body),
    });

  it('needs a key with the email:mcp scope', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, false)).statusCode).toBe(401);
    const other = await makeApiKey(['storefront:read']);
    const res = await app.inject({ method: 'POST', url: '/api/mcp', headers: { 'content-type': 'application/json', authorization: `Bearer ${other.raw}` }, payload: '{}' });
    expect(res.statusCode).toBe(403);
    await other.remove();
  });

  it('initialises and lists the tools over HTTP', async () => {
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    expect(init.statusCode).toBe(200);
    expect(init.json().result.serverInfo.name).toBe('smmta');
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.json().result.tools.length).toBe(EMAIL_TOOLS.length);
    expect((await app.inject({ method: 'GET', url: '/api/mcp' })).statusCode).toBe(405);
  });
});
