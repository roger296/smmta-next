/**
 * The admin MCP connector (docs/MCP-CONNECTOR.md): key issuing, the HTTP
 * endpoint, the guard rails, and a real round trip through an MCP client —
 * customer, product, order, invoice, credit note — run through the admin's
 * own routes as the key's user.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildApp } from '../../app.js';
import { getDb } from '../../config/database.js';
import { apiKeys, mcpAudit, users, warehouses } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { buildMcpServer } from '../email/mcp/server.js';
import { ADMIN_TOOLS } from './tools.js';
import { allowedRoutes } from './catalogue.js';

let app: FastifyInstance;
const COMPANY = getSingletonCompanyId();
const email = `mcp-${Date.now()}@example.com`;
let userId: string;
let userJwt: string;
const keyNames: string[] = [];
/** Rows the round trip creates, removed afterwards with everything that points at them. */
const made: Array<{ table: string; id: string }> = [];

/** A uuid list as one Postgres array literal (drizzle would spread a JS array). */
const pgArray = (ids: string[]) => `{${ids.join(',')}}`;

/** Delete a row and, first, every row that references it (found from the
 *  database's own foreign keys; links that cascade or set null are left to
 *  Postgres), so other suites' clean-ups are not blocked. */
async function purge(table: string, ids: string[], depth = 0): Promise<void> {
  if (!ids.length || depth > 6) return;
  const db = getDb();
  const refs = (
    await db.execute(sql`
      select cl.relname as tbl, att.attname as col
      from pg_constraint con
      join pg_class cl on cl.oid = con.conrelid
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
      where con.contype = 'f' and con.confdeltype in ('a', 'r') and con.confrelid = ${table}::regclass`)
  ).rows as Array<{ tbl: string; col: string }>;
  for (const r of refs) {
    if (r.tbl === table) continue;
    const hasId = (await db.execute(sql`select 1 from information_schema.columns where table_name = ${r.tbl} and column_name = 'id'`)).rows.length > 0;
    if (!hasId) {
      await db.execute(sql`delete from ${sql.identifier(r.tbl)} where ${sql.identifier(r.col)} = any(${pgArray(ids)}::uuid[])`);
      continue;
    }
    const child = (await db.execute(sql`select id::text from ${sql.identifier(r.tbl)} where ${sql.identifier(r.col)} = any(${pgArray(ids)}::uuid[])`)).rows as Array<{ id: string }>;
    await purge(r.tbl, child.map((c) => c.id), depth + 1);
  }
  await db.execute(sql`delete from ${sql.identifier(table)} where id = any(${pgArray(ids)}::uuid[])`);
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  // Leftovers from an interrupted earlier run.
  const db = getDb();
  const old = async (q: ReturnType<typeof sql>) => ((await db.execute(q)).rows as Array<{ id: string }>).map((r) => r.id);
  const oldProducts = await old(sql`select id::text from products where name like 'MCP Widget %'`);
  const oldCustomers = await old(sql`select id::text from customers where name like 'MCP Customer %'`);
  await purge('customer_orders', await old(sql`select id::text from customer_orders where customer_id = any(${pgArray(oldCustomers)}::uuid[])`));
  await purge('products', oldProducts);
  await purge('customers', oldCustomers);
  await db.execute(sql`delete from users where email like 'mcp-%@example.com'`);
  const [u] = await getDb()
    .insert(users)
    .values({ companyId: COMPANY, email, passwordHash: 'x:y', name: 'MCP Test' })
    .returning();
  userId = u!.id;
  userJwt = app.jwt.sign({ userId, companyId: COMPANY, email, roles: ['admin'] });
});

afterAll(async () => {
  const db = getDb();
  for (const table of ['credit_notes', 'invoices', 'customer_orders', 'products', 'customers']) {
    await purge(table, made.filter((m) => m.table === table).map((m) => m.id));
  }
  if (keyNames.length) await db.delete(apiKeys).where(inArray(apiKeys.name, keyNames));
  await db.delete(mcpAudit).where(eq(mcpAudit.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  await app.close();
});

async function issue(scopes: string[], jwt = userJwt) {
  const name = `mcp-test-${randomUUID().slice(0, 8)}`;
  keyNames.push(name);
  return app.inject({
    method: 'POST',
    url: '/api/v1/admin/api-keys',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    payload: { name, scopes },
  });
}

async function client(canApprove = false) {
  const server = buildMcpServer(
    { actor: 'claude', canApprove },
    { email: false, admin: { app, user: { id: userId, email, roles: ['admin'] }, keyPrefix: 'testpfx', canApprove } },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(b);
  return c;
}

const text = (r: any) => (r.content?.[0]?.text as string) ?? '';
async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${text(r)}`);
  return JSON.parse(text(r));
}

describe('issuing a connector key', () => {
  it('ties an admin:mcp key to the signed-in user who issues it', async () => {
    const res = await issue(['admin:mcp']);
    expect(res.statusCode).toBe(201);
    expect(res.json().data.actingUserId).toBe(userId);
  });

  it('refuses an admin:mcp key from a token whose user does not exist', async () => {
    const ghost = app.jwt.sign({ userId: randomUUID(), companyId: COMPANY, email: 'ghost@example.com', roles: ['admin'] });
    expect((await issue(['admin:mcp'], ghost)).statusCode).toBe(400);
  });

  it('can now issue the email scopes the email MCP docs describe', async () => {
    expect((await issue(['email:mcp'])).statusCode).toBe(201);
  });
});

describe('the HTTP endpoint', () => {
  const rpc = (key: string, body: object) =>
    app.inject({
      method: 'POST',
      url: '/api/mcp',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: body,
    });
  const initialise = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } };

  it('lists the admin tools for an admin:mcp key, and not the email ones', async () => {
    const key = (await issue(['admin:mcp'])).json().data.key as string;
    expect((await rpc(key, initialise)).statusCode).toBe(200);
    const list = await rpc(key, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = (list.json().result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('admin_create_invoice');
    expect(names.some((n) => n.startsWith('email_'))).toBe(false);
    // A real call over HTTP runs the route as the key's user.
    const got = await rpc(key, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'admin_list_customers', arguments: { pageSize: 1 } } });
    const result = got.json().result;
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: 200, success: true });
  });

  it('refuses a key with neither scope, and an admin key whose user is gone', async () => {
    const plain = (await issue(['orders:read'])).json().data.key as string;
    expect((await rpc(plain, initialise)).statusCode).toBe(403);
    const orphan = await issue(['admin:mcp']);
    await getDb().update(apiKeys).set({ actingUserId: null }).where(eq(apiKeys.id, orphan.json().data.id));
    expect((await rpc(orphan.json().data.key, initialise)).statusCode).toBe(403);
  });
});

describe('the guard rails', () => {
  it('cannot mint keys, sign in, or approve a campaign without email:approve', async () => {
    const c = await client();
    const tryReq = async (method: string, path: string) => c.callTool({ name: 'admin_request', arguments: { method, path, body: {} } });
    for (const [m, p] of [['POST', '/admin/api-keys'], ['POST', '/auth/login'], ['POST', `/email/campaigns/${randomUUID()}/approve`]] as const) {
      const r = await tryReq(m, p);
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/not open/);
    }
    const listed = await call(c, 'admin_list_endpoints', { search: 'api-keys' });
    expect(listed.count).toBe(0);
    expect(allowedRoutes(true).some((r) => r.path.endsWith('/approve'))).toBe(true);
  });

  it('resolves dot segments before checking, so a path cannot sneak round the refused list', async () => {
    const c = await client();
    for (const path of ['/products/../admin/api-keys', '/products/%2e%2e/admin/api-keys', '/api/v1/customers/../auth/login']) {
      const r = await c.callTool({ name: 'admin_request', arguments: { method: 'POST', path, body: {} } });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/not open/);
    }
  });

  it('names an unknown route rather than guessing', async () => {
    const c = await client();
    const r = await c.callTool({ name: 'admin_get', arguments: { path: '/no-such-thing' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/no GET \/no-such-thing route/);
  });

  it("passes the route's own validation error back", async () => {
    const c = await client();
    const r = await c.callTool({ name: 'admin_request', arguments: { method: 'POST', path: '/customers', body: { name: '' } } });
    expect(r.isError).toBe(true);
    expect(JSON.parse(text(r)).status).toBe(400);
  });
});

describe('a round trip through MCP', () => {
  it('creates and edits a customer, product and order, invoices it and credits it, all recorded as the user', async () => {
    const c = await client();
    const db = getDb();
    const [wh] = await db.select().from(warehouses).where(eq(warehouses.companyId, COMPANY)).limit(1);

    const customer = (await call(c, 'admin_create_customer', { name: `MCP Customer ${Date.now()}`, email: `cust-${Date.now()}@example.com` })).data;
    made.push({ table: 'customers', id: customer.id });
    await call(c, 'admin_update_customer', { id: customer.id, creditTermDays: 14 });
    expect((await call(c, 'admin_get_customer', { id: customer.id })).data.creditTermDays).toBe(14);

    const product = (await call(c, 'admin_create_product', { name: `MCP Widget ${Date.now()}`, stockCode: `MCP-${Date.now()}`, expectedNextCost: 2 })).data;
    made.push({ table: 'products', id: product.id });
    await call(c, 'admin_update_product', { id: product.id, description: 'Edited through MCP' });
    expect((await call(c, 'admin_get_product', { id: product.id })).data.description).toBe('Edited through MCP');

    const order = (
      await call(c, 'admin_create_order', {
        customerId: customer.id,
        orderDate: '2026-11-05',
        ...(wh ? { warehouseId: wh.id } : {}),
        lines: [{ productId: product.id, quantity: 2, pricePerUnit: 10, taxRate: 20 }],
      })
    ).data;
    made.push({ table: 'customer_orders', id: order.id });
    await call(c, 'admin_update_order', { id: order.id, customerOrderNumber: 'PO-MCP-1' });
    const full = (await call(c, 'admin_get_order', { id: order.id })).data;
    expect(full.customerOrderNumber).toBe('PO-MCP-1');
    expect((await call(c, 'admin_list_orders', { customerId: customer.id })).data).toHaveLength(1);

    const invoice = (await call(c, 'admin_create_invoice', { orderId: order.id, dateOfInvoice: '2026-11-05' })).data;
    made.push({ table: 'invoices', id: invoice.id });
    expect(invoice.id).toBeTruthy();
    const credit = (
      await call(c, 'admin_create_credit_note', {
        invoiceId: invoice.id,
        dateOfCreditNote: '2026-11-05',
        lines: [{ productId: product.id, quantity: 1, pricePerUnit: 10, taxRate: 20 }],
      })
    ).data;
    expect(credit.id).toBeTruthy();
    made.push({ table: 'credit_notes', id: credit.id });

    // Generic reads reach the rest of the admin.
    const inv = await call(c, 'admin_get', { path: `/invoices/${invoice.id}` });
    expect(inv.status).toBe(200);

    const trail = await db
      .select()
      .from(mcpAudit)
      .where(and(eq(mcpAudit.userId, userId), eq(mcpAudit.tool, 'admin_create_invoice')))
      .orderBy(desc(mcpAudit.createdAt));
    expect(trail[0]).toMatchObject({ method: 'POST', path: `/orders/${order.id}/invoice`, status: 201, ok: true, keyPrefix: 'testpfx' });
  });
});

describe('the docs', () => {
  it('list every admin tool', async () => {
    const doc = readFileSync(resolve(process.cwd(), '../../docs/MCP-CONNECTOR.md'), 'utf8');
    const documented = [...doc.matchAll(/^\| `(admin_[a-z_]+)` \|/gm)].map((m) => m[1]).sort();
    expect(documented).toEqual(ADMIN_TOOLS.map((t) => t.name).sort());
  });
});
