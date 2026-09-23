/**
 * MCP server (P14, spec §A9). Real Postgres + the built app.
 *
 * Covers: discovery metadata; an unauthenticated /mcp call → 401 with the
 * RFC 9728 resource-metadata hint; tools/list; a tool returns the same data as
 * its service equivalent; every tool call writes one audit row; the read-only
 * stock-take tools report progress and who counted each line.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import { apiKeys, mcpAuditLog, products, sites, stockLevels, stockTakes } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { StockQueryService } from '../stock/stock-query.service.js';
import { StockTakeService } from '../stock-take/stock-take.service.js';

const COMPANY = getSingletonCompanyId();
let app: FastifyInstance;
let key: string;
let siteId: string;
let productId: string;

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.delete(mcpAuditLog).where(eq(mcpAuditLog.companyId, COMPANY));
  // stock_takes.site_id does not cascade; the take's lines cascade from it.
  const site = await db.query.sites.findFirst({ where: eq(sites.slug, 'mcp-site') });
  if (site) await db.delete(stockTakes).where(eq(stockTakes.siteId, site.id));
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
  // Key names are unique per company and nothing removes them, so a second run
  // against the same database was refused with 409 and every test skipped.
  await getDb().delete(apiKeys).where(and(eq(apiKeys.companyId, COMPANY), eq(apiKeys.name, 'mcp-test')));
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

describe('stock-takes (read-only)', () => {
  let takeId: string;

  beforeAll(async () => {
    const service = new StockTakeService();
    const { take } = await service.open({
      siteId,
      scope: 'FULL',
      companyId: COMPANY,
      openedBy: { userId: 'pin:sam', name: 'Sam' },
    });
    takeId = take.id;
    await service.recordCounts(takeId, [{ productId, countedQty: 4000 }], { userId: 'pin:alex', name: 'Alex' });
  });

  const textOf = (res: Awaited<ReturnType<typeof call>>) => JSON.parse(res.json().result.content[0].text);

  it('stock_takes lists the site\'s takes with progress and counters', async () => {
    const res = await call('tools/call', { name: 'stock_takes', arguments: { site: 'mcp-site', status: 'open' } });
    expect(res.statusCode).toBe(200);
    const takes = textOf(res) as Array<Record<string, unknown>>;
    const mine = takes.find((t) => t.id === takeId)!;
    expect(mine).toMatchObject({ openedByName: 'Sam', status: 'OPEN', countedCount: 1, counters: ['Alex'] });
  });

  it('stock_takes refuses an unknown site rather than listing every site', async () => {
    const res = await call('tools/call', { name: 'stock_takes', arguments: { site: 'no-such-site' } });
    expect(textOf(res)).toEqual({ error: 'Unknown site: no-such-site' });
  });

  it('stock_take_detail names who counted each line', async () => {
    const res = await call('tools/call', { name: 'stock_take_detail', arguments: { stockTakeId: takeId } });
    const detail = textOf(res);
    expect(detail.take.id).toBe(takeId);
    const line = (detail.lines as Array<Record<string, unknown>>).find((l) => l.productId === productId)!;
    expect(line).toMatchObject({ productName: 'MCP Flour', countedByName: 'Alex', bookQty: '4200.000', countedQty: '4000.000' });
    expect(Number(line.variance)).toBe(-200);
  });

  it('a read key reading a take changes nothing', async () => {
    const before = await new StockTakeService().get(takeId, COMPANY);
    await call('tools/call', { name: 'stock_take_detail', arguments: { stockTakeId: takeId } });
    const after = await new StockTakeService().get(takeId, COMPANY);
    expect(after).toEqual(before);
  });
});

