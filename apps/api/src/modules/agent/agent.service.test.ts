/**
 * Sales-agent tests (Prompt 8, SPEC §14). Real Postgres; scripted FakeLlm
 * driving the REAL tools against seeded data. Proves the structural safety
 * properties (no identity params; prices only via the engine; spend cap).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import {
  products,
  warehouses,
  stockItems,
  pricingRules,
  chatSessions,
  chatMessages,
  baskets,
  basketLines,
  llmLog,
  escalations,
} from '../../db/schema/index.js';
import { AgentService } from './agent.service.js';
import { TOOL_SCHEMAS } from './tools.js';
import { OpenRouterService } from '../../integrations/openrouter/openrouter.service.js';
import { FakeLlm } from '../../integrations/openrouter/openrouter.fake.js';

const COMPANY = getSingletonCompanyId();
const IN_STOCK_SKU = 'AGT-PETG-BLK';
const OOS_SKU = 'AGT-PLA-OOS';
let warehouseId: string;

function makeAgent(fake: FakeLlm): AgentService {
  return new AgentService(new OpenRouterService(fake));
}

beforeAll(async () => {
  const db = getDb();
  await db
    .insert(pricingRules)
    .values({ companyId: COMPANY, category: null, preorderBands: [{ minDaysToEta: 0, discountBp: 500 }], lowStockThreshold: 5 })
    .onConflictDoNothing();
  const [wh] = await db
    .insert(warehouses)
    .values({ companyId: COMPANY, name: 'Agent Test WH', isDefault: false })
    .returning({ id: warehouses.id });
  warehouseId = wh!.id;
  const [inStock] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'Matte Black PETG 1.75mm', stockCode: IN_STOCK_SKU, minSellingPrice: '22.99' })
    .returning({ id: products.id });
  await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'PLA Out Of Stock', stockCode: OOS_SKU, minSellingPrice: '19.99' });
  // 10 IN_STOCK units for the in-stock SKU.
  await db.insert(stockItems).values(
    Array.from({ length: 10 }, () => ({
      companyId: COMPANY,
      productId: inStock!.id,
      warehouseId,
      quantity: 1,
      status: 'IN_STOCK' as const,
    })),
  );
});

afterEach(async () => {
  const db = getDb();
  await db.delete(chatMessages).where(eq(chatMessages.companyId, COMPANY));
  await db.delete(escalations).where(eq(escalations.companyId, COMPANY));
  await db.delete(chatSessions).where(eq(chatSessions.companyId, COMPANY));
  await db.delete(basketLines).where(eq(basketLines.companyId, COMPANY));
  await db.delete(baskets).where(eq(baskets.companyId, COMPANY));
  await db.delete(llmLog).where(eq(llmLog.companyId, COMPANY));
});

afterAll(async () => {
  const db = getDb();
  await db.delete(stockItems).where(eq(stockItems.warehouseId, warehouseId));
  await db.delete(products).where(and(eq(products.companyId, COMPANY), eq(products.stockCode, IN_STOCK_SKU)));
  await db.delete(products).where(and(eq(products.companyId, COMPANY), eq(products.stockCode, OOS_SKU)));
  await db.delete(warehouses).where(eq(warehouses.id, warehouseId));
  await closeDatabase();
});

describe('tool schemas — structural anti-injection (§14.1)', () => {
  it('no tool accepts a user / session / basket identifier', () => {
    for (const tool of TOOL_SCHEMAS) {
      const props = Object.keys((tool.parameters as { properties?: object }).properties ?? {});
      for (const key of props) {
        expect(/user_?id|session_?id|basket_?id/i.test(key)).toBe(false);
      }
    }
  });
});

describe('happy path — search → quote → add, priced by the engine', () => {
  it('builds a basket whose price came only from the pricing engine', async () => {
    const fake = new FakeLlm().enqueue(
      { toolCalls: [{ name: 'search_catalogue', arguments: { query: 'matte black petg' } }] },
      { toolCalls: [{ name: 'quote_price', arguments: { sku: IN_STOCK_SKU, qty: 2 } }] },
      { toolCalls: [{ name: 'add_to_basket', arguments: { sku: IN_STOCK_SKU, qty: 2 } }] },
      { content: 'Added two rolls of matte black PETG to your basket.' },
    );
    const agent = makeAgent(fake);
    const { sessionId } = await agent.startSession();
    const result = await agent.runTurn(sessionId, "I'd like some matte black PETG");

    expect(result.content).toMatch(/matte black PETG/i);
    expect(result.basket.lines).toHaveLength(1);
    expect(result.basket.lines[0]!.qty).toBe(2);
    // £22.99 warehouse, no discount → 2299p unit, 4598p line.
    expect(result.basket.lines[0]!.unitPricePence).toBe(2299);
    expect(result.basket.totalPence).toBe(4598);

    // llm_log recorded every model call this turn.
    const logs = await getDb().select().from(llmLog).where(eq(llmLog.companyId, COMPANY));
    expect(logs.length).toBe(4);
  });
});

describe('out-of-stock → inbound offer flow', () => {
  it('add_to_basket on a warehouse-empty SKU returns INSUFFICIENT_STOCK', async () => {
    const fake = new FakeLlm().enqueue(
      { toolCalls: [{ name: 'add_to_basket', arguments: { sku: OOS_SKU, qty: 1 } }] },
      { toolCalls: [{ name: 'get_stock_and_eta', arguments: { sku: OOS_SKU } }] },
      { content: "That colour is out of stock, but you can pre-order it." },
    );
    const agent = makeAgent(fake);
    const { sessionId } = await agent.startSession();
    await agent.runTurn(sessionId, 'add the out of stock one');

    const toolMsgs = await getDb()
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.sessionId, sessionId), eq(chatMessages.role, 'tool')));
    const envelopes = toolMsgs.map((m) => m.toolResults as { ok: boolean; error?: { code: string } });
    expect(envelopes.some((e) => e.ok === false && e.error?.code === 'INSUFFICIENT_STOCK')).toBe(true);
  });
});

describe('spend cap', () => {
  it('winds down gracefully when today’s spend is over the cap', async () => {
    // Seed a logged cost above the default £2/day cap (2,000,000 micro-USD).
    await getDb().insert(llmLog).values({
      companyId: COMPANY,
      purpose: 'chat',
      model: 'seed',
      requestJson: {},
      costMicroUsd: 2_000_000,
    });
    const fake = new FakeLlm().enqueue({ content: 'unused' });
    const agent = makeAgent(fake);
    const { sessionId } = await agent.startSession();
    const result = await agent.runTurn(sessionId, 'hello');
    expect(result.windDown).toBe('spend_cap');
    // The model was never called (cap tripped first).
    expect(fake.calls).toHaveLength(0);
  });
});

describe('anonymous session', () => {
  it('get_customer_interests returns LOGIN_REQUIRED without a user', async () => {
    const fake = new FakeLlm().enqueue(
      { toolCalls: [{ name: 'get_customer_interests', arguments: {} }] },
      { content: 'You can sign in to see your saved watches.' },
    );
    const agent = makeAgent(fake);
    const { sessionId } = await agent.startSession(); // anonymous
    await agent.runTurn(sessionId, 'what am I watching?');
    const toolMsgs = await getDb()
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.sessionId, sessionId), eq(chatMessages.role, 'tool')));
    const env = toolMsgs[0]!.toolResults as { ok: boolean; error?: { code: string } };
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('LOGIN_REQUIRED');
  });
});
