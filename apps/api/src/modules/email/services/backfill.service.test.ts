/**
 * Backfill on a fixture of 20 customers: 5 with orders, 2 trade, 3 with
 * evidence of marketing consent. Running it twice changes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { getDb } from '../../../config/database.js';
import { getSingletonCompanyId } from '../../../shared/auth/company.js';
import {
  consentRecords,
  customers,
  emailConsentEvents,
  emailContacts,
  newsletterSubscribers,
  storefrontUsers,
  suppressionList,
} from '../../../db/schema/index.js';
import { BackfillService } from './backfill.service.js';
import { cleanupFixtures, makeCustomer, makeGroup, makeOrder, makeProduct, uniqueEmail } from '../testing.js';

afterAll(() => cleanupFixtures());

const COMPANY = getSingletonCompanyId();
const emails: string[] = [];
const ids: Record<string, string> = {};

beforeAll(async () => {
  const db = getDb();
  for (let i = 0; i < 20; i++) {
    const e = uniqueEmail('bf');
    emails.push(e);
    // Store the address messily, as old data does.
    const c = await makeCustomer(i === 0 ? `  ${e.toUpperCase()} ` : e, `Backfill ${i}`);
    ids[e] = c.id;
  }
  const petg = await makeGroup('Landu PETG Pro 1.75mm 1kg');
  const petgBlack = await makeProduct('PETG Black', { groupId: petg.id });
  const pla = await makeProduct('Landu PLA Basic White');

  // 0–4 have orders; 4 bought 12 of one SKU (trade by bulk).
  await makeOrder(ids[emails[0]!]!, [{ productId: petgBlack.id, quantity: 1 }], '2026-09-01');
  await makeOrder(ids[emails[1]!]!, [{ productId: pla.id, quantity: 2 }], '2026-08-01');
  await makeOrder(ids[emails[2]!]!, [{ productId: pla.id, quantity: 1 }, { productId: petgBlack.id, quantity: 1 }]);
  await makeOrder(ids[emails[3]!]!, [{ productId: petgBlack.id, quantity: 3 }]);
  await makeOrder(ids[emails[4]!]!, [{ productId: pla.id, quantity: 12 }]);

  // 5 is a trade storefront user.
  await db.insert(storefrontUsers).values({ companyId: COMPANY, email: emails[5]!, kind: 'trade' });
  // 6, 7: active newsletter; 8: consent record granted; 9: granted then revoked.
  for (const e of [emails[6]!, emails[7]!]) {
    await db.insert(newsletterSubscribers).values({ companyId: COMPANY, email: e, source: 'footer', unsubscribeToken: randomBytes(32).toString('hex') });
  }
  const [u8] = await db.insert(storefrontUsers).values({ companyId: COMPANY, email: emails[8]! }).returning();
  await db.insert(consentRecords).values({ companyId: COMPANY, userId: u8!.id, consentType: 'general_marketing', granted: true, source: 'checkout' });
  const [u9] = await db.insert(storefrontUsers).values({ companyId: COMPANY, email: emails[9]! }).returning();
  await db.insert(consentRecords).values({ companyId: COMPANY, userId: u9!.id, consentType: 'general_marketing', granted: true, source: 'checkout', createdAt: new Date('2026-01-01') });
  await db.insert(consentRecords).values({ companyId: COMPANY, userId: u9!.id, consentType: 'general_marketing', granted: false, source: 'unsubscribe', createdAt: new Date('2026-02-01') });
  // 10 bounced, 11 complained (on the existing suppression list).
  await db.insert(suppressionList).values([
    { email: emails[10]!, companyId: COMPANY, reason: 'bounce' },
    { email: emails[11]!, companyId: COMPANY, reason: 'complaint' },
  ]);
});

async function snapshot() {
  const db = getDb();
  const rows = await db.select().from(emailContacts).where(inArray(emailContacts.email, emails)).orderBy(emailContacts.email);
  const ev = await db.select({ id: emailConsentEvents.id }).from(emailConsentEvents).where(inArray(emailConsentEvents.contactId, rows.map((r) => r.id)));
  return { rows, events: ev.length };
}

describe('BackfillService', () => {
  it('creates the expected contacts, statuses, interests and links, and a second run changes nothing', async () => {
    const counts = await new BackfillService().run();
    expect(counts.created).toBeGreaterThanOrEqual(20);
    expect(counts.tradeRule).toMatch(/kind trade/);

    const { rows, events } = await snapshot();
    expect(rows).toHaveLength(20);
    expect(events).toBe(20);
    const by = (i: number) => rows.find((r) => r.email === emails[i])!;

    // Consent only from evidence.
    for (const i of [6, 7, 8]) expect(by(i).marketingStatus).toBe('all');
    const others = rows.filter((r) => ![emails[6], emails[7], emails[8]].includes(r.email));
    for (const r of others) expect(r.marketingStatus).toBe('transactional_only');
    expect(by(8).consentAt).not.toBeNull();

    // Interests and last order from history.
    expect(Object.keys(by(0).interests)).toEqual(['material:petg']);
    expect(by(0).interests['material:petg']!.score).toBe(10);
    expect(Object.keys(by(2).interests).sort()).toEqual(['material:petg', 'material:pla']);
    expect(by(1).lastOrderAt?.toISOString().slice(0, 10)).toBe('2026-08-01');
    for (const i of [0, 1, 2, 3, 4]) expect(by(i).lastOrderAt).not.toBeNull();
    for (const i of [5, 6, 7]) expect(by(i).lastOrderAt).toBeNull();

    // Trade: the trade storefront user and the bulk buyer.
    expect(rows.filter((r) => r.isTrade).map((r) => r.email).sort()).toEqual([emails[4], emails[5]].sort());

    // Suppressions carried across.
    expect(by(10).deliverability).toBe('hard_bounce');
    expect(by(11).deliverability).toBe('complained');

    // Every customer links to its contact, including the messy address.
    const custs = await getDb().select({ id: customers.id, contactId: customers.contactId }).from(customers).where(inArray(customers.id, Object.values(ids)));
    for (const c of custs) expect(c.contactId).not.toBeNull();
    const [c0] = await getDb().select().from(customers).where(eq(customers.id, ids[emails[0]!]!));
    expect(c0!.contactId).toBe(by(0).id);

    // Second run: nothing changes.
    await new BackfillService().run();
    const again = await snapshot();
    expect(again.events).toBe(events);
    expect(again.rows.map((r) => ({ ...r, updatedAt: null }))).toEqual(rows.map((r) => ({ ...r, updatedAt: null })));
  });
});
