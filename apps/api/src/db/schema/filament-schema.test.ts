/**
 * Schema-invariant tests for the New Filament Store tables (Prompt 2, SPEC §13).
 * Real Postgres at DATABASE_URL. Proves the enforced invariants:
 *  - consent_records is append-only (UPDATE/DELETE blocked by trigger)
 *  - interest_flags uniqueness holds even when sku/prospective_id are NULL
 *  - inbound_shipment_lines.qty_presold defaults to 0
 *  - merged_into never cascades a delete of the survivor
 *  - seed:dev runs idempotently
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import {
  storefrontUsers,
  authIdentities,
  consentRecords,
  interestFlags,
  inboundShipments,
  inboundShipmentLines,
  prospectiveProducts,
  pricingRules,
} from './index.js';
import { seedDev } from '../../../scripts/seed-dev.js';

const COMPANY = getSingletonCompanyId();
const TEST_EMAIL = 'schema-inv@example.test';

async function makeUser(email = TEST_EMAIL): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(storefrontUsers)
    .values({ companyId: COMPANY, email, kind: 'guest' })
    .returning({ id: storefrontUsers.id });
  return row!.id;
}

async function cleanup(): Promise<void> {
  const db = getDb();
  // Delete children before parents. consent_records is append-only, so we
  // temporarily disable the trigger to clean up test rows (always re-enabled).
  await db.execute(sql`ALTER TABLE consent_records DISABLE TRIGGER consent_records_no_delete`);
  await db.execute(sql`ALTER TABLE consent_records DISABLE TRIGGER consent_records_no_update`);
  try {
    const users = await db
      .select({ id: storefrontUsers.id })
      .from(storefrontUsers)
      .where(eq(storefrontUsers.email, TEST_EMAIL));
    for (const u of users) {
      await db.delete(consentRecords).where(eq(consentRecords.userId, u.id));
      await db.delete(interestFlags).where(eq(interestFlags.userId, u.id));
      await db.delete(authIdentities).where(eq(authIdentities.userId, u.id));
    }
    await db.delete(storefrontUsers).where(eq(storefrontUsers.email, TEST_EMAIL));
  } finally {
    await db.execute(sql`ALTER TABLE consent_records ENABLE TRIGGER consent_records_no_delete`);
    await db.execute(sql`ALTER TABLE consent_records ENABLE TRIGGER consent_records_no_update`);
  }
}

afterEach(cleanup);
afterAll(async () => {
  await closeDatabase();
});

describe('consent_records append-only', () => {
  it('rejects UPDATE and DELETE', async () => {
    const db = getDb();
    const userId = await makeUser();
    const [row] = await db
      .insert(consentRecords)
      .values({ companyId: COMPANY, userId, consentType: 'general_marketing', granted: true, source: 't' })
      .returning({ id: consentRecords.id });

    await expect(
      db.update(consentRecords).set({ granted: false }).where(eq(consentRecords.id, row!.id)),
    ).rejects.toThrow(/append-only/i);

    await expect(
      db.delete(consentRecords).where(eq(consentRecords.id, row!.id)),
    ).rejects.toThrow(/append-only/i);

    // The row is still there — revocation is a NEW row, not a mutation.
    const rows = await db.select().from(consentRecords).where(eq(consentRecords.id, row!.id));
    expect(rows).toHaveLength(1);
  });
});

describe('interest_flags uniqueness (NULLS NOT DISTINCT)', () => {
  it('dedups a duplicate prospective-only watch even though sku is NULL', async () => {
    const db = getDb();
    const userId = await makeUser();
    const [prospective] = await db
      .insert(prospectiveProducts)
      .values({ companyId: COMPANY, name: 'Inv Test Prospective' })
      .returning({ id: prospectiveProducts.id });

    const values = {
      companyId: COMPANY,
      userId,
      sku: null,
      prospectiveId: prospective!.id,
      flagType: 'register_interest' as const,
    };
    await db.insert(interestFlags).values(values);
    await expect(db.insert(interestFlags).values(values)).rejects.toThrow(/uq_flag|duplicate/i);

    await db.delete(interestFlags).where(eq(interestFlags.userId, userId));
    await db.delete(prospectiveProducts).where(eq(prospectiveProducts.id, prospective!.id));
  });
});

describe('inbound_shipment_lines defaults', () => {
  it('qty_presold defaults to 0', async () => {
    const db = getDb();
    const eta = new Date();
    const [shipment] = await db
      .insert(inboundShipments)
      .values({ companyId: COMPANY, reference: 'INV-TEST-1', etaOriginal: eta, eta })
      .returning({ id: inboundShipments.id });
    const [line] = await db
      .insert(inboundShipmentLines)
      .values({ companyId: COMPANY, shipmentId: shipment!.id, sku: 'INV-SKU', qtyManifested: 100 })
      .returning();
    expect(line!.qtyPresold).toBe(0);

    await db.delete(inboundShipmentLines).where(eq(inboundShipmentLines.shipmentId, shipment!.id));
    await db.delete(inboundShipments).where(eq(inboundShipments.id, shipment!.id));
  });
});

describe('merged_into never cascades', () => {
  it('setting merged_into on a loser leaves the survivor untouched', async () => {
    const db = getDb();
    const survivor = await makeUser('schema-inv@example.test');
    const [loser] = await db
      .insert(storefrontUsers)
      .values({ companyId: COMPANY, email: null, kind: 'guest', mergedInto: survivor })
      .returning({ id: storefrontUsers.id });

    // Deleting the loser must NOT touch the survivor (no cascade).
    await db.delete(storefrontUsers).where(eq(storefrontUsers.id, loser!.id));
    const stillThere = await db
      .select()
      .from(storefrontUsers)
      .where(eq(storefrontUsers.id, survivor));
    expect(stillThere).toHaveLength(1);
  });
});

describe('seed:dev idempotency', () => {
  it('runs twice without error and without duplicating pricing_rules / shipments', async () => {
    await seedDev();
    await seedDev();
    const db = getDb();
    const rules = await db
      .select()
      .from(pricingRules)
      .where(and(eq(pricingRules.companyId, COMPANY)));
    // Exactly one default (category NULL) ruleset.
    expect(rules.filter((r) => r.category === null)).toHaveLength(1);

    const ships = await db
      .select()
      .from(inboundShipments)
      .where(eq(inboundShipments.reference, 'SEA-2026-070'));
    expect(ships).toHaveLength(1);
  });
});
