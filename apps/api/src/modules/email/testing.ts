/**
 * Test helpers shared by the email module's tests: unique addresses and
 * small fixtures. Every address is @example.com (runbook D9).
 */
import { randomUUID } from 'node:crypto';
import { inArray, like } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { resetEnvForTests } from '../../config/env.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import {
  customerOrders,
  customers,
  emailContacts,
  emailSettings,
  orderLines,
  productGroups,
  products,
} from '../../db/schema/index.js';
import { ContactsService, type FindOrCreateOptions } from './services/contacts.service.js';
import type { EmailSettingKey } from './lib/settings-defaults.js';

let seq = 0;

/** Rows the fixtures made, so `cleanupFixtures` can remove them: other suites
 *  wipe the catalogue and must not trip over our orders. */
const made = { orders: [] as string[], products: [] as string[], groups: [] as string[], customers: [] as string[] };
const RUN = Date.now().toString(36);

/** A fresh address no other test uses. */
export function uniqueEmail(tag = 't'): string {
  return `em-${tag}-${RUN}-${++seq}@example.com`;
}

export async function makeContact(
  over: Partial<FindOrCreateOptions> & { email?: string } = {},
) {
  const { email, ...opts } = over;
  const { contact } = await new ContactsService().findOrCreateByEmail(email ?? uniqueEmail(), {
    source: 'admin',
    actor: 'test',
    ...opts,
  });
  return contact;
}

export async function makeProduct(name: string, extra: Partial<typeof products.$inferInsert> = {}) {
  const db = getDb();
  const [p] = await db
    .insert(products)
    .values({
      companyId: getSingletonCompanyId(),
      name,
      slug: `em-${RUN}-${++seq}`,
      isPublished: true,
      minSellingPrice: '19.99',
      ...extra,
    })
    .returning();
  made.products.push(p!.id);
  return p!;
}

export async function makeGroup(name: string) {
  const [g] = await getDb()
    .insert(productGroups)
    .values({ companyId: getSingletonCompanyId(), name, slug: `emg-${RUN}-${++seq}` })
    .returning();
  made.groups.push(g!.id);
  return g!;
}

export async function makeCustomer(email: string | null, name = 'Test Customer') {
  const [c] = await getDb()
    .insert(customers)
    .values({ companyId: getSingletonCompanyId(), name, email })
    .returning();
  made.customers.push(c!.id);
  return c!;
}

export async function makeOrder(
  customerId: string,
  lines: Array<{ productId: string; quantity: number; price?: string }>,
  orderDate = '2026-10-01',
) {
  const db = getDb();
  const [o] = await db
    .insert(customerOrders)
    .values({
      companyId: getSingletonCompanyId(),
      orderNumber: `EM-${RUN}-${++seq}`,
      customerId,
      orderDate,
      status: 'CONFIRMED',
      grandTotal: lines.reduce((s, l) => s + l.quantity * Number(l.price ?? '20'), 0).toFixed(2),
    })
    .returning();
  made.orders.push(o!.id);
  for (const l of lines) {
    const price = l.price ?? '20.00';
    await db.insert(orderLines).values({
      orderId: o!.id,
      productId: l.productId,
      quantity: l.quantity,
      pricePerUnit: price,
      lineTotal: (Number(price) * l.quantity).toFixed(2),
    });
  }
  return o!;
}

/** Remove every order, product, group and customer the fixtures made. Email
 *  contacts stay (their consent events are append-only); their customer link
 *  is cleared first. */
export async function cleanupFixtures(): Promise<void> {
  const db = getDb();
  if (made.orders.length) {
    await db.delete(orderLines).where(inArray(orderLines.orderId, made.orders));
    await db.delete(customerOrders).where(inArray(customerOrders.id, made.orders));
  }
  if (made.customers.length) {
    await db.update(emailContacts).set({ customerId: null }).where(inArray(emailContacts.customerId, made.customers));
    await db.delete(customers).where(inArray(customers.id, made.customers));
  }
  if (made.products.length) {
    await db.delete(products).where(inArray(products.id, made.products));
  }
  if (made.groups.length) await db.delete(productGroups).where(inArray(productGroups.id, made.groups));
  made.orders = [];
  made.products = [];
  made.groups = [];
  made.customers = [];
}

/** Override settings for a test; returns a restore function. */
export async function withSettings(patch: Partial<Record<EmailSettingKey, unknown>>): Promise<() => Promise<void>> {
  const db = getDb();
  const keys = Object.keys(patch);
  const before = await db.select().from(emailSettings).where(inArray(emailSettings.key, keys));
  for (const [key, value] of Object.entries(patch)) {
    await db
      .insert(emailSettings)
      .values({ key, value: value as object })
      .onConflictDoUpdate({ target: emailSettings.key, set: { value: value as object } });
  }
  return async () => {
    await db.delete(emailSettings).where(inArray(emailSettings.key, keys));
    if (before.length) await db.insert(emailSettings).values(before);
  };
}

/** Sets EMAIL_TEST_ALLOWLIST for one test; returns the undo. */
export function setEnvAllowlist(list: string): () => void {
  const before = process.env.EMAIL_TEST_ALLOWLIST;
  process.env.EMAIL_TEST_ALLOWLIST = list;
  resetEnvForTests();
  return () => {
    if (before === undefined) delete process.env.EMAIL_TEST_ALLOWLIST;
    else process.env.EMAIL_TEST_ALLOWLIST = before;
    resetEnvForTests();
  };
}

export { randomUUID, like };
