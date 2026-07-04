/**
 * Inbound shipments — pre-order stock pools (SPEC §13.4, F1).
 *
 * Mode-agnostic (sea / air / road / rail / courier). A few typed common fields
 * plus a `tracking_refs` jsonb array that holds any number of references in any
 * format. Presale availability per line = qty_manifested × (1 − buffer/100) −
 * qty_presold. Money in integer pence (unit price snapshots live on the pricing
 * side, not here). Enum style follows THE SPEC's text-enum.
 */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import { pk, companyId } from './common.js';

export interface TrackingRef {
  kind: string; // 'container_no' | 'bill_of_lading' | 'awb' | 'courier_tracking' | 'vessel' | 'supplier_po' | ...
  value: string;
  carrier?: string;
  url?: string;
}

export const inboundShipments = pgTable('inbound_shipments', {
  id: pk(),
  companyId: companyId(),
  reference: text('reference').notNull(), // our internal ref (human-friendly)
  mode: text('mode', {
    enum: ['sea', 'air', 'road', 'rail', 'courier'],
  })
    .notNull()
    .default('sea'),
  supplier: text('supplier'),
  carrier: text('carrier'), // shipping line / airline / courier name
  etaOriginal: timestamp('eta_original', { withTimezone: true }).notNull(), // kept for supplier-reliability metrics
  eta: timestamp('eta', { withTimezone: true }).notNull(), // current
  status: text('status', {
    enum: ['booked', 'in_transit', 'at_port', 'customs', 'received', 'reconciled'],
  })
    .notNull()
    .default('booked'),
  // Multi-format tracking. `kind` is free text by design — new formats need no
  // migration. See TrackingRef.
  trackingRefs: jsonb('tracking_refs')
    .$type<TrackingRef[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  trackingUrl: text('tracking_url'), // primary "click to track" link for admin UI
  notes: text('notes'),
  bufferPct: integer('buffer_pct').notNull().default(8), // held back from presale
  arrivedAt: timestamp('arrived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const inboundShipmentLines = pgTable(
  'inbound_shipment_lines',
  {
    id: pk(),
    companyId: companyId(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => inboundShipments.id),
    sku: text('sku').notNull(),
    qtyManifested: integer('qty_manifested').notNull(),
    qtyReceived: integer('qty_received'), // set at goods-in; variance → shipment.short_shipped
    qtyPresold: integer('qty_presold').notNull().default(0), // presale sells against manifested*(1-buffer) - presold
  },
  (t) => ({
    uqShipmentSku: uniqueIndex('uq_shipment_sku').on(t.shipmentId, t.sku),
  }),
);
