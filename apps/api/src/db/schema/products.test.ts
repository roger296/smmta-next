/**
 * Integration tests for the schema-level constraints introduced in
 * Prompt 1 (composite unique on (company_id, slug) for products and
 * product_groups, and the products.group_id FK).
 *
 * Single-tenant: the `company_id` column stays in the schema as a
 * placeholder (see `apps/api/src/shared/auth/company.ts` and the
 * Tenancy section in CLAUDE.md). We no longer assert "company A's
 * data is isolated from company B's"; the tests below use a single
 * throwaway UUID just to scope inserts/cleanup so they don't trample
 * data the storefront seed leaves behind.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { productGroups, products } from './index.js';

const TEST_COMPANY = '22222222-2222-4222-8222-222222222222';

afterAll(async () => {
  await closeDatabase();
});

describe('schema constraints — products.slug uniqueness', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.delete(products).where(eq(products.companyId, TEST_COMPANY));
    await db.delete(productGroups).where(eq(productGroups.companyId, TEST_COMPANY));
  });

  it('rejects two products with the same slug', async () => {
    const db = getDb();
    await db.insert(products).values({
      companyId: TEST_COMPANY,
      name: 'First',
      slug: 'duplicate-slug',
    });

    await expect(
      db.insert(products).values({
        companyId: TEST_COMPANY,
        name: 'Second',
        slug: 'duplicate-slug',
      }),
    ).rejects.toThrow();
  });

  it('allows multiple products with NULL slug (NULLs distinct)', async () => {
    const db = getDb();
    await db.insert(products).values({ companyId: TEST_COMPANY, name: 'A' });
    await expect(
      db.insert(products).values({ companyId: TEST_COMPANY, name: 'B' }),
    ).resolves.not.toThrow();
  });
});

describe('schema constraints — product_groups.slug uniqueness', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.delete(products).where(eq(products.companyId, TEST_COMPANY));
    await db.delete(productGroups).where(eq(productGroups.companyId, TEST_COMPANY));
  });

  it('rejects two groups with the same slug', async () => {
    const db = getDb();
    await db.insert(productGroups).values({
      companyId: TEST_COMPANY,
      name: 'First Group',
      slug: 'group-slug',
    });

    await expect(
      db.insert(productGroups).values({
        companyId: TEST_COMPANY,
        name: 'Second Group',
        slug: 'group-slug',
      }),
    ).rejects.toThrow();
  });
});

describe('schema constraints — products.group_id FK to product_groups', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.delete(products).where(eq(products.companyId, TEST_COMPANY));
    await db.delete(productGroups).where(eq(productGroups.companyId, TEST_COMPANY));
  });

  it('rejects insert with a group_id that does not exist', async () => {
    const db = getDb();
    await expect(
      db.insert(products).values({
        companyId: TEST_COMPANY,
        name: 'Orphan',
        groupId: '99999999-9999-4999-8999-999999999999',
      }),
    ).rejects.toThrow();
  });

  it('accepts insert with a real group_id', async () => {
    const db = getDb();
    const [group] = await db
      .insert(productGroups)
      .values({ companyId: TEST_COMPANY, name: 'Real Group' })
      .returning();
    if (!group) throw new Error('group insert returned no row');

    await expect(
      db.insert(products).values({
        companyId: TEST_COMPANY,
        name: 'Variant',
        groupId: group.id,
      }),
    ).resolves.not.toThrow();
  });

  it('accepts insert with group_id = null (standalone product)', async () => {
    const db = getDb();
    await expect(
      db.insert(products).values({
        companyId: TEST_COMPANY,
        name: 'Standalone',
        groupId: null,
      }),
    ).resolves.not.toThrow();
  });
});

// ── D-2: products.count_quantum (Aug-2026 feedback set) ─────────────────────
describe('products.count_quantum', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.delete(products).where(eq(products.companyId, TEST_COMPANY));
  });

  it('defaults to NULL — meaning "do not bucket counts of this product"', async () => {
    const db = getDb();
    const [p] = await db
      .insert(products)
      .values({ companyId: TEST_COMPANY, name: 'Quantum default', slug: 'quantum-default' })
      .returning();
    // The migration adds the column to EVERY existing row as NULL, so no
    // product anywhere silently starts rounding its counts.
    expect(p!.countQuantum).toBeNull();
  });

  it('stores a positive quantum at 4dp', async () => {
    const db = getDb();
    const [p] = await db
      .insert(products)
      .values({
        companyId: TEST_COMPANY,
        name: 'Scooped flour',
        slug: 'scooped-flour',
        stockUom: 'g',
        countQuantum: '100.0000',
      })
      .returning();
    expect(Number(p!.countQuantum)).toBe(100);
  });

  it('rejects a zero or negative quantum — "no bucketing" is spelled NULL', async () => {
    const db = getDb();
    await expect(
      db.insert(products).values({
        companyId: TEST_COMPANY,
        name: 'Zero quantum',
        slug: 'zero-quantum',
        countQuantum: '0',
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(products).values({
        companyId: TEST_COMPANY,
        name: 'Negative quantum',
        slug: 'negative-quantum',
        countQuantum: '-5',
      }),
    ).rejects.toThrow();
  });
});
