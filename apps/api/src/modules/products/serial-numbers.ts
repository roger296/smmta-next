/**
 * The rules for serial numbers on stock coming in, shared by booking-in and
 * manual stock adds.
 *
 * A product flagged requireSerialNumber gets one serial per unit: none missing,
 * none blank, none repeated, and none already on a live stock item of the same
 * product. Serials are compared without regard to case or surrounding spaces,
 * and stored trimmed as typed. The unique index on stock_items (migration 0040)
 * is the backstop for two people booking in the same serial at once.
 *
 * A product that is not serial-tracked stores no serials, whatever was sent.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../../db/schema/index.js';
import { stockItems } from '../../db/schema/index.js';

export class SerialNumberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerialNumberError';
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const listed = (values: string[]) => values.slice(0, 5).join(', ') + (values.length > 5 ? ` and ${values.length - 5} more` : '');

/**
 * The serials to store, one per unit in order, or null for each unit of a
 * product that is not serial-tracked. Throws SerialNumberError saying what to fix.
 */
export async function serialsForIncomingStock(
  db: NodePgDatabase<typeof schema>,
  companyId: string,
  product: { id: string; name: string; requireSerialNumber: boolean },
  quantity: number,
  serialNumbers: string[] | undefined,
): Promise<Array<string | null>> {
  if (!product.requireSerialNumber) return Array.from({ length: quantity }, () => null);

  const serials = (serialNumbers ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
  if (serials.length !== quantity) {
    throw new SerialNumberError(
      `${product.name} is serial-tracked: ${plural(quantity, 'unit')} need ${plural(quantity, 'serial number')}, and ${serials.length} ${serials.length === 1 ? 'was' : 'were'} given.`,
    );
  }

  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const s of serials) {
    const key = s.toLowerCase();
    if (seen.has(key)) repeated.add(s);
    seen.add(key);
  }
  if (repeated.size > 0) {
    throw new SerialNumberError(`Serial numbers entered more than once for ${product.name}: ${listed([...repeated])}.`);
  }

  const existing: string[] = [];
  const keys = [...seen];
  for (let i = 0; i < keys.length; i += 1000) {
    const rows = await db
      .select({ serialNumber: stockItems.serialNumber })
      .from(stockItems)
      .where(
        and(
          eq(stockItems.companyId, companyId),
          eq(stockItems.productId, product.id),
          isNull(stockItems.deletedAt),
          inArray(sql`lower(${stockItems.serialNumber})`, keys.slice(i, i + 1000)),
        ),
      );
    existing.push(...rows.map((r) => r.serialNumber ?? ''));
  }
  if (existing.length > 0) {
    throw new SerialNumberError(`Already in the system for ${product.name}: ${listed(existing)}.`);
  }
  return serials;
}
