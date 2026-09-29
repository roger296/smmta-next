import { eq, and, isNull } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { goodsReceivedNotes } from '../../db/schema/index.js';

/**
 * GRNService — read access to the inherited Goods Received Notes.
 *
 * Booking stock in against a purchase order used to live here (`bookIn`). It
 * wrote the inherited warehouse `stock_items` model, which nothing in
 * Auto-Stock reads, so it was retired in Sept 2026 (DECISIONS.md §F24):
 * deliveries against an order are booked through `GoodsInService.receive`
 * into the venue's stock ledger. What remains lists any GRNs already on file.
 */
export class GRNService {
  private db = getDb();

  // ── List GRNs for a PO ──

  async listByPO(purchaseOrderId: string) {
    return this.db.query.goodsReceivedNotes.findMany({
      where: and(
        eq(goodsReceivedNotes.purchaseOrderId, purchaseOrderId),
        isNull(goodsReceivedNotes.deletedAt),
      ),
      with: { lines: { with: { product: true } } },
      orderBy: (g, { desc }) => [desc(g.createdAt)],
    });
  }

  // ── Get by ID ──

  async getById(id: string, companyId: string) {
    return this.db.query.goodsReceivedNotes.findFirst({
      where: and(
        eq(goodsReceivedNotes.id, id),
        eq(goodsReceivedNotes.companyId, companyId),
        isNull(goodsReceivedNotes.deletedAt),
      ),
      with: {
        purchaseOrder: { with: { supplier: true } },
        lines: { with: { product: true } },
      },
    });
  }
}
