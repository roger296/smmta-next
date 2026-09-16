/**
 * "Brakes sent us a line reading A33891 — what is that?"
 *
 * One mapping owns one canonical `supplier_sku` (the code you quote back to
 * the supplier) plus any number of aliases (other spellings the same code
 * arrives as). Both resolve to the mapping; only the canonical one is ever
 * sent outbound.
 *
 * This is the point of the alias table. Invoice OCR returns "33891",
 * "A 33891" and "A33891" for one Brakes line across three invoices; without
 * resolution the second and third fail to match and get re-keyed by hand.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { supplierProductAliases, supplierProducts } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

export type SupplierProductRow = typeof supplierProducts.$inferSelect;

export interface SkuResolution {
  supplierProduct: SupplierProductRow;
  /** CANONICAL = it is the mapping's own code; ALIAS = a known other spelling. */
  matchedVia: 'CANONICAL' | 'ALIAS';
  /** The code as stored, so a caller can show what it actually matched. */
  matchedSku: string;
}

/** Trimmed + lower-cased. Codes are compared this way everywhere. */
export function normaliseSku(sku: string): string {
  return sku.trim().toLowerCase();
}

/**
 * Find the mapping a supplier's code refers to, canonical or alias.
 *
 * Canonical wins when a code is somehow both — that should be prevented on
 * write (see `aliasConflict`), but resolution must still be deterministic if
 * old data slipped through, and the canonical code is the more authoritative
 * of the two.
 */
export async function resolveSupplierSku(
  supplierId: string,
  sku: string,
  companyId = getSingletonCompanyId(),
): Promise<SkuResolution | null> {
  const db = getDb();
  const wanted = normaliseSku(sku);
  if (!wanted) return null;

  const [canonical] = await db
    .select()
    .from(supplierProducts)
    .where(
      and(
        eq(supplierProducts.companyId, companyId),
        eq(supplierProducts.supplierId, supplierId),
        isNull(supplierProducts.deletedAt),
        sql`lower(btrim(${supplierProducts.supplierSku})) = ${wanted}`,
      ),
    )
    .limit(1);
  if (canonical) {
    return { supplierProduct: canonical, matchedVia: 'CANONICAL', matchedSku: canonical.supplierSku };
  }

  const [viaAlias] = await db
    .select({ mapping: supplierProducts, aliasSku: supplierProductAliases.aliasSku })
    .from(supplierProductAliases)
    .innerJoin(
      supplierProducts,
      eq(supplierProducts.id, supplierProductAliases.supplierProductId),
    )
    .where(
      and(
        eq(supplierProductAliases.supplierId, supplierId),
        isNull(supplierProductAliases.deletedAt),
        // A soft-deleted mapping must stop resolving, or a retired line keeps
        // catching invoice matches.
        isNull(supplierProducts.deletedAt),
        sql`lower(btrim(${supplierProductAliases.aliasSku})) = ${wanted}`,
      ),
    )
    .limit(1);
  if (viaAlias) {
    return { supplierProduct: viaAlias.mapping, matchedVia: 'ALIAS', matchedSku: viaAlias.aliasSku };
  }

  return null;
}

export interface AliasConflict {
  aliasSku: string;
  reason: string;
}

/**
 * Why an alias cannot be added, if it cannot.
 *
 * Two collisions matter, and the unique index only catches one of them:
 *
 * - the alias is another MAPPING's canonical code for this supplier — the
 *   index cannot see across tables, and allowing it would make one code
 *   resolve to two different purchasable lines;
 * - the alias already belongs to a different mapping for this supplier — the
 *   index does catch this, but as a 500 rather than a sentence.
 *
 * An alias equal to its OWN mapping's canonical code is not a conflict, it is
 * just redundant, and callers drop it rather than refusing the save.
 */
export async function aliasConflict(
  supplierId: string,
  aliasSku: string,
  ownMappingId: string | null,
  companyId = getSingletonCompanyId(),
): Promise<AliasConflict | null> {
  const db = getDb();
  const wanted = normaliseSku(aliasSku);
  if (!wanted) return null;

  const [asCanonical] = await db
    .select({ id: supplierProducts.id, sku: supplierProducts.supplierSku })
    .from(supplierProducts)
    .where(
      and(
        eq(supplierProducts.companyId, companyId),
        eq(supplierProducts.supplierId, supplierId),
        isNull(supplierProducts.deletedAt),
        sql`lower(btrim(${supplierProducts.supplierSku})) = ${wanted}`,
      ),
    )
    .limit(1);
  if (asCanonical && asCanonical.id !== ownMappingId) {
    return {
      aliasSku,
      reason: `"${aliasSku}" is already this supplier's main code for another line. A code can only point at one thing.`,
    };
  }

  const [asAlias] = await db
    .select({ id: supplierProductAliases.id, mappingId: supplierProductAliases.supplierProductId })
    .from(supplierProductAliases)
    .where(
      and(
        eq(supplierProductAliases.supplierId, supplierId),
        isNull(supplierProductAliases.deletedAt),
        sql`lower(btrim(${supplierProductAliases.aliasSku})) = ${wanted}`,
      ),
    )
    .limit(1);
  if (asAlias && asAlias.mappingId !== ownMappingId) {
    return {
      aliasSku,
      reason: `"${aliasSku}" is already an alternative code on another line for this supplier.`,
    };
  }

  return null;
}

/**
 * Replace a mapping's aliases with exactly this set.
 *
 * Soft-deletes the ones left out rather than hard-deleting: an alias carries
 * where it came from and when an invoice last used it, which is worth keeping
 * when somebody asks why a code stopped matching.
 */
export async function replaceAliases(
  supplierProductId: string,
  supplierId: string,
  aliases: ReadonlyArray<{ aliasSku: string; source?: string; lastSeenAt?: Date | null }>,
  companyId = getSingletonCompanyId(),
): Promise<void> {
  const db = getDb();

  const existing = await db
    .select()
    .from(supplierProductAliases)
    .where(
      and(
        eq(supplierProductAliases.supplierProductId, supplierProductId),
        isNull(supplierProductAliases.deletedAt),
      ),
    );
  const existingByKey = new Map(existing.map((a) => [normaliseSku(a.aliasSku), a]));
  const wantedKeys = new Set(aliases.map((a) => normaliseSku(a.aliasSku)));

  for (const alias of aliases) {
    const key = normaliseSku(alias.aliasSku);
    const found = existingByKey.get(key);
    if (found) {
      await db
        .update(supplierProductAliases)
        .set({
          aliasSku: alias.aliasSku.trim(),
          ...(alias.source ? { source: alias.source } : {}),
          ...(alias.lastSeenAt !== undefined ? { lastSeenAt: alias.lastSeenAt } : {}),
          updatedAt: new Date(),
        })
        .where(eq(supplierProductAliases.id, found.id));
      continue;
    }
    await db.insert(supplierProductAliases).values({
      companyId,
      supplierProductId,
      supplierId,
      aliasSku: alias.aliasSku.trim(),
      source: alias.source ?? 'MANUAL',
      lastSeenAt: alias.lastSeenAt ?? null,
    });
  }

  for (const a of existing) {
    if (!wantedKeys.has(normaliseSku(a.aliasSku))) {
      await db
        .update(supplierProductAliases)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(supplierProductAliases.id, a.id));
    }
  }
}
