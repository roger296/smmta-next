import { eq, and, isNull, ilike } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { manufacturers } from '../../db/schema/index.js';

/**
 * ManufacturerService — CRUD for manufacturers.
 *
 * Source: Old app DSB.Data/AppContext/Manufacturer.cs
 */
export class ManufacturerService {
  private db = getDb();

  async list(search?: string) {
    const conditions = [isNull(manufacturers.deletedAt)];
    if (search) conditions.push(ilike(manufacturers.name, `%${search}%`));

    return this.db.query.manufacturers.findMany({
      where: and(...conditions),
      orderBy: (m, { asc }) => [asc(m.name)],
    });
  }

  async getById(id: string) {
    return this.db.query.manufacturers.findFirst({
      where: and(eq(manufacturers.id, id), isNull(manufacturers.deletedAt)),
    });
  }

  async create(input: {
    name: string;
    description?: string;
    logoUrl?: string;
    website?: string;
    customerSupportPhone?: string;
    customerSupportEmail?: string;
    techSupportPhone?: string;
    techSupportEmail?: string;
  }) {
    const [mfr] = await this.db.insert(manufacturers).values(input).returning();
    return mfr;
  }

  async update(id: string, input: Partial<{
    name: string;
    description: string;
    logoUrl: string;
    website: string;
    customerSupportPhone: string;
    customerSupportEmail: string;
    techSupportPhone: string;
    techSupportEmail: string;
  }>) {
    const [updated] = await this.db
      .update(manufacturers)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(manufacturers.id, id), isNull(manufacturers.deletedAt)))
      .returning();
    return updated;
  }

  async delete(id: string) {
    const result = await this.db
      .update(manufacturers)
      .set({ deletedAt: new Date() })
      .where(and(eq(manufacturers.id, id), isNull(manufacturers.deletedAt)));
    return (result.rowCount ?? 0) > 0;
  }
}
