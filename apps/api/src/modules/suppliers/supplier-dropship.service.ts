/**
 * Drop-ship supplier service.
 *
 * Thin wrapper that takes a supplierId, decrypts its API credentials,
 * resolves the right connector via the registry, and dispatches calls.
 * The wrapper is the only place encrypt/decrypt live for supplier API
 * keys — connectors only ever see plaintext, callers only ever see
 * the connector's neutral types.
 *
 * Distinct from the existing `apps/api/src/modules/purchasing/supplier.service.ts`,
 * which handles the PO-side of supplier records (contacts, addresses,
 * payment terms). Both modules read from the same `suppliers` table —
 * one row can be both a PO supplier and a drop-ship supplier.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { suppliers } from '../../db/schema/index.js';
import { encrypt } from '../../shared/crypto/encrypt.js';
import { resolveConnector } from '../../integrations/suppliers/registry.js';
import type {
  SupplierConnector,
  SupplierOrderRequest,
  SupplierOrderResponse,
  SupplierOrderStatus,
  SupplierStockSnapshot,
} from '../../integrations/suppliers/types.js';

/** Type-narrowed `suppliers` row, restricted to the columns the
 *  connector resolver and connectors actually use. */
type SupplierRow = typeof suppliers.$inferSelect;

export class DropshipSupplierService {
  private db = getDb();

  /** Encrypt a plaintext API key for storage. Exposed so admin endpoints
   *  can run the encrypt step at write time without reaching for the
   *  crypto module directly. */
  encryptApiKey(plaintext: string): string {
    return encrypt(plaintext);
  }

  /** Find an active drop-ship supplier by id, or null if missing /
   *  inactive / lacking the integration columns. */
  async getActiveSupplier(supplierId: string): Promise<SupplierRow | null> {
    const row = await this.db.query.suppliers.findFirst({
      where: eq(suppliers.id, supplierId),
    });
    if (!row) return null;
    if (!row.isDropshipActive) return null;
    if (!row.apiBaseUrl || !row.apiKeyEnc) return null;
    return row;
  }

  /** Resolve the connector for a supplier, with optional override (test
   *  harnesses pass a stub directly). */
  async getConnector(
    supplierId: string,
    override?: SupplierConnector,
  ): Promise<{ supplier: SupplierRow; connector: SupplierConnector }> {
    const supplier = await this.getActiveSupplier(supplierId);
    if (!supplier) {
      throw new Error(`Drop-ship supplier ${supplierId} not active or not found`);
    }
    const connector = override ?? resolveConnector(supplier);
    return { supplier, connector };
  }

  // ── delegating methods ───────────────────────────────────────────

  async getStockAndPrice(
    supplierId: string,
    supplierSkus: string[],
    override?: SupplierConnector,
  ): Promise<SupplierStockSnapshot[]> {
    const { connector } = await this.getConnector(supplierId, override);
    return connector.getStockAndPrice(supplierSkus);
  }

  async placeOrder(
    supplierId: string,
    req: SupplierOrderRequest,
    override?: SupplierConnector,
  ): Promise<SupplierOrderResponse> {
    const { connector } = await this.getConnector(supplierId, override);
    return connector.placeOrder(req);
  }

  async getOrderStatus(
    supplierId: string,
    orderRef: string,
    override?: SupplierConnector,
  ): Promise<SupplierOrderStatus> {
    const { connector } = await this.getConnector(supplierId, override);
    return connector.getOrderStatus(orderRef);
  }

  async cancelOrder(
    supplierId: string,
    orderRef: string,
    override?: SupplierConnector,
  ): Promise<{ ok: boolean; reason?: string }> {
    const { connector } = await this.getConnector(supplierId, override);
    return connector.cancelOrder(orderRef);
  }
}
