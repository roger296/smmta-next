/**
 * Supplier price observations (supplier-ordering groundwork, plan §3.3, §5.1).
 *
 * Every price seen for a buying option, with its source and date. This module
 * records them, answers "what did we last pay for this code", and back-fills
 * the history from BumbleBee's OCR'd invoices.
 *
 * What it deliberately does NOT do yet:
 *  - touch `supplier_products.cost_gbp`. Deriving it from the history changes
 *    what the reorder engine picks, and that belongs with the Phase 1 ranking,
 *    where it can be seen and overridden on the ordering screen.
 *  - record goods-in prices. Today's goods-in carries no supplier code, and
 *    when nobody types a cost it books `expected_next_cost` — recording that
 *    would feed our own guess back in as an observation. It starts recording
 *    when goods-in is booked against a PO line (the code and pack are known).
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import {
  sites,
  supplierPriceObservations,
  supplierProductAliases,
  supplierProducts,
  suppliers,
} from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { isJunkSku, unitCost, type InvoiceLine } from './invoice-sku-extract.js';
import { normaliseSku } from './supplier-sku-resolver.js';

export type PriceObservation = typeof supplierPriceObservations.$inferSelect;
export type PriceObservationSource = PriceObservation['source'];

/** Older than this, a price is shown as stale (decision C, default — confirm with owners). */
export const STALE_PRICE_DAYS = 60;

export interface LatestPrice {
  unitPrice: string;
  currencyCode: string;
  source: PriceObservationSource;
  observedAt: Date;
  documentRef: string | null;
  /** Days since it was observed, at the time of the query. */
  ageDays: number;
  stale: boolean;
}

/** The newest observation for each mapping. One query for the lot. */
export async function latestPrices(
  supplierProductIds: string[],
  now = new Date(),
): Promise<Map<string, LatestPrice>> {
  const out = new Map<string, LatestPrice>();
  if (supplierProductIds.length === 0) return out;
  const rows = await getDb()
    .selectDistinctOn([supplierPriceObservations.supplierProductId])
    .from(supplierPriceObservations)
    .where(inArray(supplierPriceObservations.supplierProductId, supplierProductIds))
    .orderBy(
      supplierPriceObservations.supplierProductId,
      sql`${supplierPriceObservations.observedAt} DESC`,
      sql`${supplierPriceObservations.createdAt} DESC`,
    );
  for (const r of rows) {
    const ageDays = Math.floor((now.getTime() - r.observedAt.getTime()) / 86_400_000);
    out.set(r.supplierProductId, {
      unitPrice: r.unitPrice,
      currencyCode: r.currencyCode,
      source: r.source,
      observedAt: r.observedAt,
      documentRef: r.documentRef,
      ageDays,
      stale: ageDays > STALE_PRICE_DAYS,
    });
  }
  return out;
}

// ── Back-fill from OCR'd invoices ─────────────────────────────────────────

export type InvoiceSkipReason =
  | 'NO_CODE'
  | 'NO_PRICE'
  | 'NO_DATE'
  | 'CREDIT_OR_ZERO'
  | 'UNKNOWN_SUPPLIER'
  | 'CODE_NOT_MAPPED'
  | 'CODE_ON_SEVERAL_LINES';

export interface InvoiceBackfillReport {
  lines: number;
  resolved: number;
  inserted: number;
  alreadyRecorded: number;
  skipped: Record<InvoiceSkipReason, number>;
  /** Per supplier name as it appears on the invoices. */
  bySupplier: Record<string, { lines: number; resolved: number }>;
  /** Codes on invoices with no mapping, busiest first — the §F20 work list. */
  unmappedCodes: Array<{ supplier: string; sku: string; description: string; lines: number }>;
  /** Codes that point at more than one purchasable line, so a price cannot
   *  be attributed. Folding them into aliases is the open §F20 work. */
  ambiguousCodes: Array<{ supplier: string; sku: string; mappings: number }>;
}

/** The same invoice line always produces the same key. */
export function invoiceSourceKey(supplierId: string, line: InvoiceLine): string {
  return [
    'INVOICE',
    supplierId,
    (line.invoice_number ?? '').trim(),
    normaliseSku(line.sku ?? ''),
    line.quantity ?? '',
    line.line_total ?? '',
  ]
    .join('|')
    .slice(0, 300);
}

/**
 * Record a price observation for every invoice line whose supplier code
 * resolves to exactly ONE buying option. Re-runnable: each line has a
 * deterministic key. `apply: false` reports what it would do and writes
 * nothing.
 */
export async function backfillFromInvoices(
  lines: InvoiceLine[],
  opts: { apply: boolean; companyId?: string },
): Promise<InvoiceBackfillReport> {
  const companyId = opts.companyId ?? getSingletonCompanyId();
  const db = getDb();

  const supplierRows = await db
    .select({ id: suppliers.id, name: suppliers.name })
    .from(suppliers)
    .where(and(eq(suppliers.companyId, companyId), isNull(suppliers.deletedAt)));
  const supplierByName = new Map(supplierRows.map((s) => [s.name.trim().toLowerCase(), s.id]));

  const siteRows = await db
    .select({ id: sites.id, canonicalName: sites.canonicalName, name: sites.name })
    .from(sites)
    .where(eq(sites.companyId, companyId));
  const siteByName = new Map<string, string>();
  for (const s of siteRows) {
    siteByName.set(s.canonicalName.trim().toLowerCase(), s.id);
    siteByName.set(s.name.trim().toLowerCase(), s.id);
  }

  // Every live code and alias, loaded once: 8,000 lines is 8,000 lookups.
  const key = (supplierId: string, sku: string) => `${supplierId}|${normaliseSku(sku)}`;
  const canonical = new Map<string, string[]>();
  for (const m of await db
    .select({ id: supplierProducts.id, supplierId: supplierProducts.supplierId, sku: supplierProducts.supplierSku })
    .from(supplierProducts)
    .where(and(eq(supplierProducts.companyId, companyId), isNull(supplierProducts.deletedAt)))) {
    const k = key(m.supplierId, m.sku);
    canonical.set(k, [...(canonical.get(k) ?? []), m.id]);
  }
  const aliases = new Map<string, string[]>();
  for (const a of await db
    .select({ mappingId: supplierProductAliases.supplierProductId, supplierId: supplierProductAliases.supplierId, sku: supplierProductAliases.aliasSku })
    .from(supplierProductAliases)
    .innerJoin(supplierProducts, eq(supplierProducts.id, supplierProductAliases.supplierProductId))
    .where(
      and(
        eq(supplierProducts.companyId, companyId),
        isNull(supplierProductAliases.deletedAt),
        isNull(supplierProducts.deletedAt),
      ),
    )) {
    const k = key(a.supplierId, a.sku);
    aliases.set(k, [...(aliases.get(k) ?? []), a.mappingId]);
  }

  const report: InvoiceBackfillReport = {
    lines: lines.length,
    resolved: 0,
    inserted: 0,
    alreadyRecorded: 0,
    skipped: {
      NO_CODE: 0,
      NO_PRICE: 0,
      NO_DATE: 0,
      CREDIT_OR_ZERO: 0,
      UNKNOWN_SUPPLIER: 0,
      CODE_NOT_MAPPED: 0,
      CODE_ON_SEVERAL_LINES: 0,
    },
    bySupplier: {},
    unmappedCodes: [],
    ambiguousCodes: [],
  };
  const unmapped = new Map<string, { supplier: string; sku: string; description: string; lines: number }>();
  const ambiguous = new Map<string, { supplier: string; sku: string; mappings: number }>();

  const pending: Array<typeof supplierPriceObservations.$inferInsert> = [];
  for (const line of lines) {
    const supplierName = (line.supplier ?? '').trim();
    const tally = (report.bySupplier[supplierName] ??= { lines: 0, resolved: 0 });
    tally.lines++;

    const sku = (line.sku ?? '').trim();
    if (!sku || isJunkSku(sku)) {
      report.skipped.NO_CODE++;
      continue;
    }
    const { cost, disagreed } = unitCost(line);
    if (cost == null) {
      report.skipped.NO_PRICE++;
      continue;
    }
    if (cost <= 0) {
      report.skipped.CREDIT_OR_ZERO++;
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(line.invoice_date ?? ''))) {
      report.skipped.NO_DATE++;
      continue;
    }
    const supplierId = supplierByName.get(supplierName.toLowerCase());
    if (!supplierId) {
      report.skipped.UNKNOWN_SUPPLIER++;
      continue;
    }
    const k = key(supplierId, sku);
    const candidates = canonical.get(k) ?? aliases.get(k) ?? [];
    const distinct = [...new Set(candidates)];
    if (distinct.length === 0) {
      report.skipped.CODE_NOT_MAPPED++;
      const u = unmapped.get(k) ?? { supplier: supplierName, sku, description: line.stock_item ?? '', lines: 0 };
      u.lines++;
      unmapped.set(k, u);
      continue;
    }
    if (distinct.length > 1) {
      // One code, several purchasable lines: which one this price belongs to
      // is exactly the question nobody has answered yet. Guessing welds a
      // price to the wrong pack.
      report.skipped.CODE_ON_SEVERAL_LINES++;
      ambiguous.set(k, { supplier: supplierName, sku, mappings: distinct.length });
      continue;
    }

    report.resolved++;
    tally.resolved++;
    pending.push({
      companyId,
      supplierProductId: distinct[0]!,
      supplierId,
      siteId: siteByName.get((line.location ?? '').trim().toLowerCase()) ?? null,
      source: 'INVOICE',
      unitPrice: cost.toFixed(6),
      currencyCode: (line.currency ?? 'GBP').toUpperCase().slice(0, 3),
      quantity: typeof line.quantity === 'number' ? String(line.quantity) : null,
      packSeen: line.pack_size ? String(line.pack_size).slice(0, 120) : null,
      // Invoice dates are calendar days; noon UTC keeps the day the same in
      // every venue's time zone.
      observedAt: new Date(`${line.invoice_date}T12:00:00Z`),
      documentRef: line.invoice_number ? String(line.invoice_number).slice(0, 120) : null,
      sourceKey: invoiceSourceKey(supplierId, line),
      note: disagreed ? 'Unit price derived from line total (OCR unit price disagreed)' : null,
    });
  }

  if (opts.apply) {
    for (let i = 0; i < pending.length; i += 500) {
      const batch = pending.slice(i, i + 500);
      const inserted = await db
        .insert(supplierPriceObservations)
        .values(batch)
        .onConflictDoNothing()
        .returning({ id: supplierPriceObservations.id });
      report.inserted += inserted.length;
      report.alreadyRecorded += batch.length - inserted.length;
    }
  }

  report.unmappedCodes = [...unmapped.values()].sort((a, b) => b.lines - a.lines);
  report.ambiguousCodes = [...ambiguous.values()].sort((a, b) => b.mappings - a.mappings);
  return report;
}
