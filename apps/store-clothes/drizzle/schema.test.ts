/**
 * Schema-shape sanity check. Doesn't talk to Postgres — just ensures
 * the drizzle module exports the 8 tables architecturally required (§11)
 * and that they look like Drizzle tables.
 */
import { describe, expect, it } from 'vitest';
import { isTable } from 'drizzle-orm';
import * as schema from './schema';

const REQUIRED_TABLES = [
  'carts',
  'cartItems',
  'checkouts',
  'molliePayments',
  'mollieRefunds',
  'webhookDeliveries',
  'idempotencyKeys',
  'emailOutbox',
] as const;

describe('storefront schema', () => {
  it('exports the 8 architectural tables', () => {
    for (const name of REQUIRED_TABLES) {
      expect(schema, `missing export ${name}`).toHaveProperty(name);
      expect(isTable((schema as Record<string, unknown>)[name])).toBe(true);
    }
  });
});
