/**
 * Integration tests for the schema-level constraints introduced in
 * Prompt 1 (composite unique on (company_id, slug) for products and
 * product_groups, and the products.group_id FK).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { productGroups, products } from './index.js';

const TEST_COMPANY_A = '22222222-2222-4222-8222-222222222222';
const TEST_COMPANY_B = '33333333-3333-4333-8333-333333333333';

afterAll(async () => {
  await closeDatabase();
});

describe('schema constraints — products.slug uniqueness per company', () => {
  beforeEach(async () => {
    const db = getDb();
    // Hard-reset just the test companies' rows.
    await db.delete(products).where(eq(products.companyId, TEST_COMPANY_A));
    await db.delete(products).where(eq(products.companyId, TEST_COMPANY_B));
    await db.delete(productGroups).where(eq(productGroups.companyId, TEST_COMPANY_A));
    await db.delete(productGroups).where(eq(productGroups.companyId, TEST_COMPANY_B));
  });

  it('rejects two products with the same slug for the same company', async () => {
    const db = getDb();
    await db.insert(products).values({
      companyId: TEST_COMPANY_A,
      name: 'First',
      slug: 'duplicate-slug',
    });

    await expect(
      db.insert(products).values({
        companyId: TEST_COMPANY_A,
        name: 'Second',
        slug: 'duplicate-slug',
      }),
    ).rejects.toThrow();
  });

  it('allows the same slug across different companies', async () => {
    const db = getDb();
    await db.insert(products).values({
      companyId: TEST_COMPANY_A,
      name: 'A',
      slug: 'shared-slug',
    });
    await expect(
      db.insert(products).values({
        companyId: TEST_COMPANY_B,
        name: 'B',
        slug: 'shared-slug',
      }),
    ).resolves.not.toThrow();
  });

  it('allows multiple products with NULL slug for the same company (NULLs distinct)', async () => {
    const db = getDb();
    await db.insert(products).values({ companyId: TEST_COMPANY_A, name: 'A' });
    await expect(
      db.insert(products).values({ companyId: TEST_COMPANY_A, name: 'B' }),
    ).resolves.not.toThrow();
  });
});

describe('schema constraints — product_groups.slug uniqueness per company', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.delete(products).where(eq(products.companyId, TEST_COMPANY_A));
    await db.delete(productGroups).where(eq(productGroups.companyId, TEST_COMPANY_A));
  });

  it('rejects two groups with the same slug for the same company', async () => {
    const db = getDb();
    await db.insert(productGroups).values({
      companyId: TEST_COMPANY_A,
      name: 'First Group',
      slug: 'group-slug',
    });

    await expect(
      db.insert(productGroups).values({
        companyId: TEST_COMPANY_A,
        name: 'Second Group',
        slug: 'group-slug',
      }),
    ).rejects.toThrow();
  });
});

describe('schema constraints — products.group_id FK to product_groups', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.delete(products).where(eq(products.companyId, TEST_COMPANY_A));
    await db.delete(productGroups).where(eq(productGroups.companyId, TEST_COMPANY_A));
  });

  it('rejects insert with a group_id that does not exist', async () => {
    const db = getDb();
    await expect(
      db.insert(products).values({
        companyId: TEST_COMPANY_A,
        name: 'Orphan',
        groupId: '99999999-9999-4999-8999-999999999999',
      }),
    ).rejects.toThrow();
  });

  it('accepts insert with a real group_id', async () => {
    const db = getDb();
    const [group] = await db
      .insert(productGroups)
      .values({ companyId: TEST_COMPANY_A, name: 'Real Group' })
      .returning();
    if (!group) throw new Error('group insert returned no row');

    await expect(
      db.insert(products).values({
        companyId: TEST_COMPANY_A,
        name: 'Variant',
        groupId: group.id,
      }),
    ).resolves.not.toThrow();
  });

  it('accepts insert with group_id = null (standalone product)', async () => {
    const db = getDb();
    await expect(
      db.insert(products).values({
        companyId: TEST_COMPANY_A,
        name: 'Standalone',
        groupId: null,
      }),
    ).resolves.not.toThrow();
  });
});
