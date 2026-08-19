import {
  pgTable,
  varchar,
  uuid,
  numeric,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { pk, companyId, auditTimestamps, goodsInVarianceEnum } from './common.js';
import { products } from './products.js';
import { sites } from './sites.js';
import { suppliers } from './purchasing.js';
import { reorderProposals } from './reorder.js';

// ============================================================
// Goods-in receipts (spec §A7) — book deliveries into the site ledger
// ------------------------------------------------------------
// A receipt converts received purchase-unit quantities to stock units,
// writes GRN movements at the receiving site, optionally matches a
// reorder proposal (partial / over / under variance), and posts a GRN
// to Xero. Idempotent on `idempotencyKey` so a re-confirm is a no-op.
// ============================================================

export const goodsInReceipts = pgTable(
  'goods_in_receipts',
  {
    id: pk(),
    companyId: companyId(),
    siteId: uuid('site_id').notNull().references(() => sites.id),
    supplierId: uuid('supplier_id').references(() => suppliers.id),
    reorderProposalId: uuid('reorder_proposal_id').references(() => reorderProposals.id),
    reference: varchar('reference', { length: 200 }),
    idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull().unique(),
    deliveryCharge: numeric('delivery_charge', { precision: 18, scale: 2 }).notNull().default('0'),
    totalStockValue: numeric('total_stock_value', { precision: 18, scale: 2 }).notNull().default('0'),
    variance: goodsInVarianceEnum('variance').notNull().default('NONE'),
    /** Photo references captured at receipt (SKU + site + timestamp) — seeds the
     *  future AI work (spec §A10). Stored as references only. */
    photoRefs: jsonb('photo_refs'),
    /** The gl_posting_log idempotency key / marker for the posted GRN. */
    glReference: varchar('gl_reference', { length: 200 }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    // ── Reversal (Aug-2026 feedback set, defect E-3) ──────────────────
    // "Accidental booking logged 100kg to Birmingham; requested an undo
    // timer." A mis-booking is corrected by a REVERSING RECEIPT — a new,
    // audited, ledger-balancing movement — never by mutating or deleting
    // history (locked decision 6). These two columns are the link between
    // the pair, in both directions, so either row explains itself.
    /** Set on the reversing receipt: the receipt it cancels. */
    reversalOfReceiptId: uuid('reversal_of_receipt_id'),
    /** Set on the ORIGINAL receipt when it has been reversed. */
    reversedByReceiptId: uuid('reversed_by_receipt_id'),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    /** Who asked for the reversal, and why — the audit trail. */
    reversedByUserId: varchar('reversed_by_user_id', { length: 200 }),
    reversalReason: text('reversal_reason'),
    ...auditTimestamps,
  },
  (t) => ({
    goodsInReceiptsSiteIdx: index('goods_in_receipts_site_idx').on(t.siteId),
    goodsInReceiptsReversalIdx: index('goods_in_receipts_reversal_idx').on(t.reversalOfReceiptId),
  }),
);

export const goodsInReceiptLines = pgTable(
  'goods_in_receipt_lines',
  {
    id: pk(),
    receiptId: uuid('receipt_id').notNull().references(() => goodsInReceipts.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').notNull().references(() => products.id),
    qtyPurchase: numeric('qty_purchase', { precision: 18, scale: 3 }).notNull(),
    qtyStock: numeric('qty_stock', { precision: 18, scale: 3 }).notNull(),
    /** Cost per purchase unit (what we pay per bag/case). */
    unitCost: numeric('unit_cost', { precision: 18, scale: 4 }).notNull().default('0'),
    lineValue: numeric('line_value', { precision: 18, scale: 2 }).notNull().default('0'),
    /** Expected (ordered) purchase qty, when matched to a proposal. */
    expectedQtyPurchase: numeric('expected_qty_purchase', { precision: 18, scale: 3 }),
    lineVariance: goodsInVarianceEnum('line_variance').notNull().default('NONE'),
    text: text('note'),
    ...auditTimestamps,
  },
  (t) => ({
    goodsInReceiptLinesReceiptIdx: index('goods_in_receipt_lines_receipt_idx').on(t.receiptId),
  }),
);

export const goodsInReceiptsRelations = relations(goodsInReceipts, ({ one, many }) => ({
  site: one(sites, { fields: [goodsInReceipts.siteId], references: [sites.id] }),
  supplier: one(suppliers, { fields: [goodsInReceipts.supplierId], references: [suppliers.id] }),
  lines: many(goodsInReceiptLines),
}));

export const goodsInReceiptLinesRelations = relations(goodsInReceiptLines, ({ one }) => ({
  receipt: one(goodsInReceipts, {
    fields: [goodsInReceiptLines.receiptId],
    references: [goodsInReceipts.id],
  }),
  product: one(products, { fields: [goodsInReceiptLines.productId], references: [products.id] }),
}));
