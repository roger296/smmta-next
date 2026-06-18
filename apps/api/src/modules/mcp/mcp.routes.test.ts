/**
 * MCP server (P14, spec §A9). Real Postgres + the built app.
 *
 * Covers: discovery metadata; an unauthenticated /mcp call → 401 with the
 * RFC 9728 resource-metadata hint; tools/list; a tool returns the same data as
 * its service equivalent; every tool call writes one audit row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import { mcpAuditLog, products, sites, stockLevels } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { StockQueryService } from '../stock/stock-query.service.js';

const COMPANY = getSingletonCompanyId();
let app: FastifyInstance;
let key: string;
let siteId: string;
let productId: string;

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.delete(mcpAuditLog).where(eq(mcpAuditLog.companyId, COMPANY));
  // Deleting the product + site cascades their stock_levels (FK onDelete cascade).
  await db.delete(products).where(eq(products.slug, 'mcp-flour'));
  await db.delete(sites).where(eq(sites.slug, 'mcp-site'));
}

async function call(method: string, params?: unknown) {
  return app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { authorization: `Bearer ${key}` },
    payload: { jsonrpc: '2.0', id: 1, method, params },
  });
}

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  app = await buildApp();
  await app.ready();
  const jwt = app.jwt.sign({ userId: 'u', companyId: COMPANY, email: 't@a.invalid', roles: ['admin'] });
  const issued = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/api-keys',
    headers: { authorization: `Bearer ${jwt}` },
    payload: { name: 'mcp-test', scopes: ['mcp:read'] },
  });
  key = issued.json().data.key as string;

  const db = getDb();
  await cleanup();
  const [s] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'mcp-site', name: 'MCP Site', canonicalName: 'MCP Site' })
    .returning();
  siteId = s!.id;
  const [p] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'MCP Flour', slug: 'mcp-flour', itemKind: 'INGREDIENT', stockUom: 'g' })
    .returning();
  productId = p!.id;
  await db.insert(stockLevels).values({ companyId: COMPANY, productId, siteId, onHand: '4200' });
});

afterAll(async () => {
  await cleanup();
  await app.close();
  await closeDatabase();
});

describe('discovery', () => {
  it('serves RFC 9728 protected-resource metadata', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
    expect(res.statusCode).toBe(200);
    const m = res.json();
    expect(m.resource).toMatch(/\/mcp$/);
    expect(m.scopes_supported).toContain('mcp:read');
  });
});

describe('auth', () => {
  it('rejects an unauthenticated /mcp call with 401 + resource-metadata hint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/resource_metadata=/);
  });
});

describe('tools', () => {
  it('lists tools and initializes', async () => {
    const init = await call('initialize');
    expect(init.json().result.serverInfo.name).toBe('auto-stock');
    const list = await call('tools/list');
    const names = list.json().result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('stock_on_hand');
    expect(names).toContain('stock_valuation');
    expect(names).toContain('product_lookup');
  });

  it('stock_on_hand returns the same data as the service, and audits the call', async () => {
    const res = await call('tools/call', { name: 'stock_on_hand', arguments: { site: siteId } });
    expect(res.statusCode).toBe(200);
    const text = res.json().result.content[0].text;
    const data = JSON.parse(text) as Array<{ productId: string; onHand: string }>;

    const expected = await new StockQueryService().listLevels({ siteId, companyId: COMPANY });
    expect(data.length).toBe(expected.length);
    expect(data.find((r) => r.productId === productId)?.onHand).toBe('4200.000');

    // Audit row written.
    const audit = await getDb()
      .select({ id: mcpAuditLog.id })
      .from(mcpAuditLog)
      .where(and(eq(mcpAuditLog.toolName, 'stock_on_hand'), eq(mcpAuditLog.companyId, COMPANY)));
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });
});
