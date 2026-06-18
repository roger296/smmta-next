/**
 * Guarded MCP action tools (P19, spec §A9). Real Postgres + the built app.
 *
 * Covers: a write tool with the write scope + confirm performs exactly one
 * audited mutation; without confirm it returns a preview and changes nothing; a
 * read-only key is rejected; replaying the same action is idempotent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import { mcpAuditLog, products, sites, stockLevels, stockMovements } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

const COMPANY = getSingletonCompanyId();
let app: FastifyInstance;
let writeKey: string;
let readKey: string;
let siteId: string;
let productId: string;

async function issueKey(jwt: string, scopes: string[]): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/api-keys',
    headers: { authorization: `Bearer ${jwt}` },
    payload: { name: `k-${scopes.join('-')}`, scopes },
  });
  return res.json().data.key as string;
}

function call(key: string, name: string, args: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { authorization: `Bearer ${key}` },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
}

const textOf = (res: Awaited<ReturnType<typeof call>>) => JSON.parse(res.json().result.content[0].text);

async function resetStock(): Promise<void> {
  const db = getDb();
  await db.delete(stockMovements).where(and(eq(stockMovements.companyId, COMPANY), eq(stockMovements.productId, productId)));
  await db
    .insert(stockLevels)
    .values({ companyId: COMPANY, productId, siteId, onHand: '1000' })
    .onConflictDoUpdate({
      target: [stockLevels.companyId, stockLevels.productId, stockLevels.siteId],
      set: { onHand: '1000' },
    });
  await db.delete(mcpAuditLog).where(and(eq(mcpAuditLog.companyId, COMPANY), eq(mcpAuditLog.toolName, 'adjust_stock')));
}

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  app = await buildApp();
  await app.ready();
  const jwt = app.jwt.sign({ userId: 'u', companyId: COMPANY, email: 't@a.invalid', roles: ['admin'] });
  writeKey = await issueKey(jwt, ['mcp:read', 'mcp:write']);
  readKey = await issueKey(jwt, ['mcp:read']);

  const db = getDb();
  await db.delete(products).where(eq(products.slug, 'mcp-act-sugar'));
  await db.delete(sites).where(eq(sites.slug, 'mcp-act-site'));
  const [s] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'mcp-act-site', name: 'Act Site', canonicalName: 'Act Site' })
    .returning();
  siteId = s!.id;
  const [p] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'Act Sugar', slug: 'mcp-act-sugar', itemKind: 'INGREDIENT', stockUom: 'g' })
    .returning();
  productId = p!.id;
});

beforeEach(resetStock);

afterAll(async () => {
  const db = getDb();
  await db.delete(stockMovements).where(and(eq(stockMovements.companyId, COMPANY), eq(stockMovements.productId, productId)));
  await db.delete(stockLevels).where(and(eq(stockLevels.companyId, COMPANY), eq(stockLevels.productId, productId)));
  await db.delete(products).where(eq(products.slug, 'mcp-act-sugar'));
  await db.delete(sites).where(eq(sites.slug, 'mcp-act-site'));
  await db.delete(mcpAuditLog).where(and(eq(mcpAuditLog.companyId, COMPANY), eq(mcpAuditLog.toolName, 'adjust_stock')));
  await app.close();
  await closeDatabase();
});

const movementCount = async () =>
  (await getDb()
    .select({ id: stockMovements.id })
    .from(stockMovements)
    .where(and(eq(stockMovements.companyId, COMPANY), eq(stockMovements.productId, productId)))).length;

describe('confirm guard', () => {
  it('without confirm returns a preview and changes nothing', async () => {
    const res = await call(writeKey, 'adjust_stock', { productId, site: siteId, qtyDelta: -100 });
    const data = textOf(res);
    expect(data.preview).toBe(true);
    expect(data.action).toBe('adjust_stock');
    expect(await movementCount()).toBe(0); // nothing mutated
  });

  it('with the write scope + confirm performs exactly one audited mutation', async () => {
    const res = await call(writeKey, 'adjust_stock', {
      productId,
      site: siteId,
      qtyDelta: -100,
      idempotencyKey: 'act-1',
      confirm: true,
    });
    const data = textOf(res);
    expect(data.executed).toBe(true);
    expect(data.result.applied).toBe(true);
    expect(Number(data.result.onHand)).toBe(900);
    expect(await movementCount()).toBe(1);

    // Audited.
    const audit = await getDb()
      .select({ id: mcpAuditLog.id })
      .from(mcpAuditLog)
      .where(and(eq(mcpAuditLog.toolName, 'adjust_stock'), eq(mcpAuditLog.ok, true)));
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });
});

describe('idempotency', () => {
  it('replaying the same action (same idempotencyKey) is a no-op', async () => {
    const args = { productId, site: siteId, qtyDelta: -100, idempotencyKey: 'act-dup', confirm: true };
    await call(writeKey, 'adjust_stock', args);
    const res2 = await call(writeKey, 'adjust_stock', args);
    const data = textOf(res2);
    expect(data.result.applied).toBe(false); // duplicate
    expect(Number(data.result.onHand)).toBe(900); // unchanged
    expect(await movementCount()).toBe(1); // still one movement
  });
});

describe('scope', () => {
  it('a read-only key cannot call a write tool', async () => {
    const res = await call(readKey, 'adjust_stock', {
      productId,
      site: siteId,
      qtyDelta: -100,
      confirm: true,
    });
    expect(res.json().error.message).toMatch(/mcp:write/);
    expect(await movementCount()).toBe(0); // nothing mutated
  });
});
