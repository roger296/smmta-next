/**
 * ReorderService (P7, spec §A7) — the automatic reordering engine.
 *
 * `evaluate(productId, siteId)` raises a replenishment when on-hand has fallen
 * to/below the reorder point: it orders up to the par level (reorder_up_to),
 * converts to the supplier's purchase unit and rounds UP to the pack size, then
 * routes by the supplier's channel + auto-place flag:
 *   - auto-place + API_CONNECTOR → PLACED (connector placement; the live call
 *     is a go-live step, recorded here);
 *   - auto-place + EMAIL_PO     → EMAILED (a rendered PO; never actually sent
 *     during the build — dry-run logs it);
 *   - not auto-place            → PROPOSED, awaiting operator approval.
 *
 * Idempotent: while an open (PROPOSED/APPROVED) proposal exists for a
 * (product, site), repeated decrements don't create a second one.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { products, reorderProposals, sites, stockLevels, suppliers } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { roundUpToPackMultiple } from '../stock/uom.js';
import { effectiveAutoPlace, preferredSupplierProduct } from '../stock/supplier-products.js';
import { renderEmailPO } from './email-po.js';
import { getSiteCurrency } from '../sites/site-currency.js';
import { DemandEstimatorService } from './demand-estimator.service.js';

const OPEN_STATUSES = ['PROPOSED', 'APPROVED'] as const;

export interface EvaluateResult {
  created: boolean;
  proposalId?: string;
  status?: string;
  reason?: string;
}

export type ReorderProposal = typeof reorderProposals.$inferSelect;

export class ReorderService {
  private db = getDb();

  /** Raise a replenishment if (product, site) is at/below its reorder point. */
  async evaluate(
    productId: string,
    siteId: string,
    opts: { triggeredBy?: 'decrement' | 'sweep' | 'manual'; companyId?: string } = {},
  ): Promise<EvaluateResult> {
    const companyId = opts.companyId ?? getSingletonCompanyId();

    const level = await this.db.query.stockLevels.findFirst({
      where: and(
        eq(stockLevels.companyId, companyId),
        eq(stockLevels.productId, productId),
        eq(stockLevels.siteId, siteId),
      ),
    });
    if (!level || level.reorderPoint == null) return { created: false, reason: 'no-reorder-point' };

    const onHand = Number(level.onHand);
    const point = Number(level.reorderPoint);
    if (onHand > point) return { created: false, reason: 'above-point' };

    // Idempotency: one open proposal per (product, site).
    const open = await this.db.query.reorderProposals.findFirst({
      where: and(
        eq(reorderProposals.companyId, companyId),
        eq(reorderProposals.productId, productId),
        eq(reorderProposals.siteId, siteId),
        inArray(reorderProposals.status, [...OPEN_STATUSES]),
      ),
    });
    if (open) return { created: false, proposalId: open.id, reason: 'already-open' };

    // Order up to par (reorder_up_to), falling back to the reorder point.
    let par = level.reorderUpTo != null ? Number(level.reorderUpTo) : point;
    // Demand-based sizing (P22): only when the site opts in. The order targets a
    // demand estimate (rate-of-use × cover) instead of the fixed par; with no
    // history (estimate 0) we keep the fixed par so we never order nothing.
    const site = await this.db.query.sites.findFirst({
      where: and(eq(sites.id, siteId), eq(sites.companyId, companyId)),
    });
    if (site?.demandReorder) {
      const demandUpTo = await new DemandEstimatorService().demandUpTo({
        productId,
        siteId,
        minDaysCover: level.minDaysCover ?? undefined,
        asOf: new Date().toISOString().slice(0, 10),
        companyId,
      });
      if (demandUpTo > 0) par = demandUpTo;
    }
    const qtyStockRaw = par - onHand;
    if (qtyStockRaw <= 0) return { created: false, reason: 'nothing-to-order' };

    const product = await this.db.query.products.findFirst({ where: eq(products.id, productId) });
    const sp = await preferredSupplierProduct(productId, companyId);
    const supplier = sp
      ? await this.db.query.suppliers.findFirst({ where: eq(suppliers.id, sp.supplierId) })
      : null;

    // stock → purchase units, rounded up to the supplier's pack size.
    const factor = Number(product?.purchaseToStockFactor ?? 1) || 1;
    const packSize = Number(sp?.supplierPackSize ?? product?.purchasePackSize ?? 1) || 1;
    const qtyPurchase = roundUpToPackMultiple(qtyStockRaw / factor, packSize);
    const qtyStock = qtyPurchase * factor;
    const unitCost = sp ? Number(sp.costGbp) : Number(product?.expectedNextCost ?? 0);

    const channel = supplier?.orderChannel ?? 'EMAIL_PO';
    const auto = sp && supplier ? effectiveAutoPlace(sp, supplier) : false;

    let status: 'PROPOSED' | 'PLACED' | 'EMAILED' = 'PROPOSED';
    let renderedPo: Record<string, unknown> | null = null;
    let supplierOrderRef: string | null = null;
    if (auto && supplier && sp) {
      if (channel === 'API_CONNECTOR') {
        status = 'PLACED';
        supplierOrderRef = `RO-${productId.slice(0, 8)}-${siteId.slice(0, 8)}`;
      } else {
        status = 'EMAILED';
        renderedPo = renderEmailPO({
          supplierName: supplier.name,
          orderEmail: supplier.orderEmail ?? supplier.email ?? null,
          siteName: (await this.siteName(siteId)) ?? siteId,
          lines: [
            {
              supplierSku: sp.supplierSku,
              productName: product?.name ?? productId,
              qty: qtyPurchase,
              uom: sp.supplierPurchaseUom ?? product?.purchaseUom ?? product?.stockUom ?? 'each',
              unitCost,
            },
          ],
        }) as unknown as Record<string, unknown>;
      }
    }

    // A supplier's currency wins (a US supplier invoices in USD); else fall back
    // to the *site's* currency, not a hardcoded GBP (spec §7).
    const currencyCode = supplier?.currencyCode ?? (await getSiteCurrency(siteId, companyId));
    const [row] = await this.db
      .insert(reorderProposals)
      .values({
        companyId,
        productId,
        siteId,
        supplierId: supplier?.id ?? null,
        suggestedQtyStock: String(qtyStock),
        suggestedQtyPurchase: String(qtyPurchase),
        purchaseUom: sp?.supplierPurchaseUom ?? product?.purchaseUom ?? null,
        unitCost: String(unitCost),
        currencyCode,
        status,
        channel: supplier ? channel : null,
        triggeredBy: opts.triggeredBy ?? 'sweep',
        renderedPo,
        supplierOrderRef,
        placedAt: status === 'PLACED' || status === 'EMAILED' ? new Date() : null,
      })
      .returning();
    return { created: true, proposalId: row!.id, status };
  }

  private async siteName(siteId: string): Promise<string | null> {
    const s = await this.db.query.sites.findFirst({ where: eq(sites.id, siteId) });
    return s?.name ?? null;
  }

  /** Approve a PROPOSED proposal (operator clears it to be placed). */
  async approve(id: string, companyId = getSingletonCompanyId()): Promise<ReorderProposal | null> {
    const [row] = await this.db
      .update(reorderProposals)
      .set({ status: 'APPROVED', updatedAt: new Date() })
      .where(
        and(
          eq(reorderProposals.id, id),
          eq(reorderProposals.companyId, companyId),
          eq(reorderProposals.status, 'PROPOSED'),
        ),
      )
      .returning();
    return row ?? null;
  }

  /** Place an approved/proposed proposal — render an emailed PO (EMAIL_PO) or
   *  record a connector placement (API_CONNECTOR). */
  async place(id: string, companyId = getSingletonCompanyId()): Promise<ReorderProposal | null> {
    const proposal = await this.db.query.reorderProposals.findFirst({
      where: and(eq(reorderProposals.id, id), eq(reorderProposals.companyId, companyId)),
    });
    if (!proposal || proposal.status === 'PLACED' || proposal.status === 'EMAILED') return proposal ?? null;

    const supplier = proposal.supplierId
      ? await this.db.query.suppliers.findFirst({ where: eq(suppliers.id, proposal.supplierId) })
      : null;
    const product = await this.db.query.products.findFirst({
      where: eq(products.id, proposal.productId),
    });

    let status: 'PLACED' | 'EMAILED' = 'EMAILED';
    let renderedPo = proposal.renderedPo as Record<string, unknown> | null;
    let supplierOrderRef = proposal.supplierOrderRef;
    if (proposal.channel === 'API_CONNECTOR') {
      status = 'PLACED';
      supplierOrderRef = supplierOrderRef ?? `RO-${proposal.id.slice(0, 12)}`;
    } else {
      status = 'EMAILED';
      renderedPo =
        renderedPo ??
        (renderEmailPO({
          supplierName: supplier?.name ?? 'Supplier',
          orderEmail: supplier?.orderEmail ?? supplier?.email ?? null,
          siteName: (await this.siteName(proposal.siteId)) ?? proposal.siteId,
          lines: [
            {
              supplierSku: '',
              productName: product?.name ?? proposal.productId,
              qty: Number(proposal.suggestedQtyPurchase ?? proposal.suggestedQtyStock),
              uom: proposal.purchaseUom ?? product?.stockUom ?? 'each',
              unitCost: Number(proposal.unitCost ?? 0),
            },
          ],
        }) as unknown as Record<string, unknown>);
    }

    const [row] = await this.db
      .update(reorderProposals)
      .set({ status, renderedPo, supplierOrderRef, placedAt: new Date(), updatedAt: new Date() })
      .where(eq(reorderProposals.id, id))
      .returning();
    return row ?? null;
  }

  /** Operator edit of the suggested purchase quantity on an open proposal. */
  async updateQty(
    id: string,
    qtyPurchase: number,
    companyId = getSingletonCompanyId(),
  ): Promise<ReorderProposal | null> {
    const proposal = await this.db.query.reorderProposals.findFirst({
      where: and(eq(reorderProposals.id, id), eq(reorderProposals.companyId, companyId)),
    });
    if (!proposal) return null;
    const product = await this.db.query.products.findFirst({
      where: eq(products.id, proposal.productId),
    });
    const factor = Number(product?.purchaseToStockFactor ?? 1) || 1;
    const [row] = await this.db
      .update(reorderProposals)
      .set({
        suggestedQtyPurchase: String(qtyPurchase),
        suggestedQtyStock: String(qtyPurchase * factor),
        updatedAt: new Date(),
      })
      .where(eq(reorderProposals.id, id))
      .returning();
    return row ?? null;
  }

  async list(
    filter: { status?: string; siteId?: string; companyId?: string } = {},
  ): Promise<ReorderProposal[]> {
    const companyId = filter.companyId ?? getSingletonCompanyId();
    const where = [eq(reorderProposals.companyId, companyId)];
    if (filter.status) where.push(eq(reorderProposals.status, filter.status as never));
    if (filter.siteId) where.push(eq(reorderProposals.siteId, filter.siteId));
    return this.db.query.reorderProposals.findMany({
      where: and(...where),
      orderBy: (p, { desc }) => [desc(p.createdAt)],
    });
  }
}
