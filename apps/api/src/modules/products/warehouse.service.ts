import { eq, and, isNull } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { warehouses } from '../../db/schema/index.js';

/**
 * WarehouseService — CRUD for warehouses.
 */
export class WarehouseService {
  private db = getDb();

  async list(companyId: string) {
    return this.db.query.warehouses.findMany({
      where: and(eq(warehouses.companyId, companyId), isNull(warehouses.deletedAt)),
      orderBy: (w, { asc }) => [asc(w.name)],
    });
  }

  async getById(id: string, companyId: string) {
    return this.db.query.warehouses.findFirst({
      where: and(eq(warehouses.id, id), eq(warehouses.companyId, companyId), isNull(warehouses.deletedAt)),
    });
  }

  async create(companyId: string, input: {
    name: string;
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    region?: string;
    postCode?: string;
    country?: string;
    isDefault?: boolean;
  }) {
    // If setting as default, unset any existing default
    if (input.isDefault) {
      await this.db
        .update(warehouses)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(and(eq(warehouses.companyId, companyId), eq(warehouses.isDefault, true)));
    }

    const [warehouse] = await this.db
      .insert(warehouses)
      .values({ companyId, ...input })
      .returning();
    return warehouse;
  }

  async update(id: string, companyId: string, input: Partial<{
    name: string;
    addressLine1: string;
    addressLine2: string;
    city: string;
    region: string;
    postCode: string;
    country: string;
    isDefault: boolean;
  }>) {
    if (input.isDefault) {
      await this.db
        .update(warehouses)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(and(eq(warehouses.companyId, companyId), eq(warehouses.isDefault, true)));
    }

    const [updated] = await this.db
      .update(warehouses)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(warehouses.id, id), eq(warehouses.companyId, companyId)))
      .returning();
    return updated;
  }

  async delete(id: string, companyId: string) {
    const result = await this.db
      .update(warehouses)
      .set({ deletedAt: new Date() })
      .where(and(eq(warehouses.id, id), eq(warehouses.companyId, companyId), isNull(warehouses.deletedAt)));
    return (result.rowCount ?? 0) > 0;
  }
}
