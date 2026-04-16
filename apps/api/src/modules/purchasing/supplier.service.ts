import { eq, and, isNull, ilike, sql, count } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import {
  suppliers, supplierContacts, supplierAddresses, supplierNotes,
} from '../../db/schema/index.js';
import type { CreateSupplierInput, UpdateSupplierInput, SupplierQueryInput } from './supplier.schema.js';
import { paginationOffset, paginationMeta } from '../../shared/utils/pagination.js';

/**
 * SupplierService — CRUD for suppliers with contacts, addresses, and notes.
 *
 * Source: Libraries/DSB.Service/Suppliers/SupplierServices.cs
 *   GetAll, GetById, Insert, Update, Delete, InsertSupplierAddress,
 *   getSupplierContact, InsertNote, Search
 */
export class SupplierService {
  private db = getDb();

  // ── List / Search ──

  async list(companyId: string, query: SupplierQueryInput) {
    const { page, pageSize, search, type } = query;
    const offset = paginationOffset(page, pageSize);

    const conditions = [eq(suppliers.companyId, companyId), isNull(suppliers.deletedAt)];
    if (search) {
      conditions.push(
        sql`(${ilike(suppliers.name, `%${search}%`)} OR ${ilike(suppliers.email, `%${search}%`)})`,
      );
    }
    if (type) conditions.push(eq(suppliers.type, type));

    const where = and(...conditions);

    const [totalResult, rows] = await Promise.all([
      this.db.select({ count: count() }).from(suppliers).where(where),
      this.db.query.suppliers.findMany({
        where,
        limit: pageSize,
        offset,
        orderBy: (s, { asc }) => [asc(s.name)],
      }),
    ]);

    return { data: rows, ...paginationMeta(Number(totalResult[0]?.count ?? 0), page, pageSize) };
  }

  // ── Get by ID (with relations) ──

  async getById(id: string, companyId: string) {
    return this.db.query.suppliers.findFirst({
      where: and(eq(suppliers.id, id), eq(suppliers.companyId, companyId), isNull(suppliers.deletedAt)),
      with: {
        contacts: { where: isNull(supplierContacts.deletedAt) },
        addresses: { where: isNull(supplierAddresses.deletedAt) },
        notes: { where: isNull(supplierNotes.deletedAt), orderBy: (n, { desc }) => [desc(n.createdAt)] },
      },
    });
  }

  // ── Create ──

  async create(companyId: string, input: CreateSupplierInput) {
    const [supplier] = await this.db
      .insert(suppliers)
      .values({
        companyId,
        name: input.name,
        type: input.type,
        email: input.email,
        accountsEmail: input.accountsEmail,
        website: input.website,
        currencyCode: input.currencyCode,
        creditLimit: input.creditLimit.toString(),
        creditTermDays: input.creditTermDays,
        taxRatePercent: input.taxRatePercent.toString(),
        vatTreatment: input.vatTreatment,
        vatRegistrationNumber: input.vatRegistrationNumber,
        countryCode: input.countryCode,
        leadTimeDays: input.leadTimeDays,
        defaultExpenseAccountCode: input.defaultExpenseAccountCode,
      })
      .returning();
    return supplier;
  }

  // ── Update ──

  async update(id: string, companyId: string, input: UpdateSupplierInput) {
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) {
        if (key === 'creditLimit' || key === 'taxRatePercent') {
          updateData[key] = (value as number).toString();
        } else {
          updateData[key] = value;
        }
      }
    }

    const [updated] = await this.db
      .update(suppliers)
      .set(updateData)
      .where(and(eq(suppliers.id, id), eq(suppliers.companyId, companyId), isNull(suppliers.deletedAt)))
      .returning();
    return updated;
  }

  // ── Soft Delete ──

  async delete(id: string, companyId: string) {
    const result = await this.db
      .update(suppliers)
      .set({ deletedAt: new Date() })
      .where(and(eq(suppliers.id, id), eq(suppliers.companyId, companyId), isNull(suppliers.deletedAt)));
    return (result.rowCount ?? 0) > 0;
  }

  // ── Contacts ──

  async addContact(supplierId: string, input: {
    name?: string; jobTitle?: string; phone?: string;
    extension?: string; mobile?: string; email?: string; skype?: string;
  }) {
    const [contact] = await this.db.insert(supplierContacts).values({ supplierId, ...input }).returning();
    return contact;
  }

  async updateContact(contactId: string, input: Record<string, unknown>) {
    const [updated] = await this.db
      .update(supplierContacts)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(supplierContacts.id, contactId), isNull(supplierContacts.deletedAt)))
      .returning();
    return updated;
  }

  async deleteContact(contactId: string) {
    const result = await this.db
      .update(supplierContacts)
      .set({ deletedAt: new Date() })
      .where(and(eq(supplierContacts.id, contactId), isNull(supplierContacts.deletedAt)));
    return (result.rowCount ?? 0) > 0;
  }

  // ── Addresses ──

  async addAddress(supplierId: string, input: {
    contactName?: string; line1?: string; line2?: string;
    city?: string; region?: string; postCode?: string;
    country?: string; addressType?: 'INVOICE' | 'WAREHOUSE';
  }) {
    const [address] = await this.db.insert(supplierAddresses).values({ supplierId, ...input }).returning();
    return address;
  }

  async updateAddress(addressId: string, input: Record<string, unknown>) {
    const [updated] = await this.db
      .update(supplierAddresses)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(supplierAddresses.id, addressId), isNull(supplierAddresses.deletedAt)))
      .returning();
    return updated;
  }

  async deleteAddress(addressId: string) {
    const result = await this.db
      .update(supplierAddresses)
      .set({ deletedAt: new Date() })
      .where(and(eq(supplierAddresses.id, addressId), isNull(supplierAddresses.deletedAt)));
    return (result.rowCount ?? 0) > 0;
  }

  // ── Notes ──

  async addNote(supplierId: string, userId: string, input: {
    note: string; attachmentUrl?: string; isMarked?: boolean;
  }) {
    const [noteRow] = await this.db
      .insert(supplierNotes)
      .values({ supplierId, userId, ...input })
      .returning();
    return noteRow;
  }

  async updateNote(noteId: string, input: { note?: string; isMarked?: boolean }) {
    const [updated] = await this.db
      .update(supplierNotes)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(supplierNotes.id, noteId), isNull(supplierNotes.deletedAt)))
      .returning();
    return updated;
  }
}
