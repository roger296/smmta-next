import { eq, and, isNull, ilike, sql, count } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import {
  customers, customerContacts, customerDeliveryAddresses,
  customerInvoiceAddresses, customerNotes, customerTypes,
  customerProductPrices,
} from '../../db/schema/index.js';
import type { CreateCustomerInput, UpdateCustomerInput, CustomerQueryInput } from './customer.schema.js';
import { paginationOffset, paginationMeta } from '../../shared/utils/pagination.js';

/**
 * CustomerService — Full CRUD with contacts, addresses, notes, types, product prices.
 *
 * Source: Libraries/DSB.Service/Customers/CustomerServices.cs (73 public methods)
 *   GetAll, GetById, Insert, Update, Delete, GetByCustomerEmail,
 *   InsertCustomerNote, getCustomerDeliveryAddress, getCustomerInvoiceAddress
 */
export class CustomerService {
  private db = getDb();

  // ================================================================
  // List / Search
  // ================================================================

  async list(companyId: string, query: CustomerQueryInput) {
    const { page, pageSize, search, typeId } = query;
    const offset = paginationOffset(page, pageSize);

    const conditions = [eq(customers.companyId, companyId), isNull(customers.deletedAt)];
    if (search) {
      conditions.push(
        sql`(${ilike(customers.name, `%${search}%`)} OR ${ilike(customers.email, `%${search}%`)} OR ${ilike(customers.shortName, `%${search}%`)})`,
      );
    }
    if (typeId) conditions.push(eq(customers.typeId, typeId));

    const where = and(...conditions);

    const [totalResult, rows] = await Promise.all([
      this.db.select({ count: count() }).from(customers).where(where),
      this.db.query.customers.findMany({
        where,
        with: { type: true },
        limit: pageSize,
        offset,
        orderBy: (c, { asc }) => [asc(c.name)],
      }),
    ]);

    return { data: rows, ...paginationMeta(Number(totalResult[0]?.count ?? 0), page, pageSize) };
  }

  // ================================================================
  // Get by ID (full detail with all relations)
  // ================================================================

  async getById(id: string, companyId: string) {
    return this.db.query.customers.findFirst({
      where: and(eq(customers.id, id), eq(customers.companyId, companyId), isNull(customers.deletedAt)),
      with: {
        type: true,
        contacts: { where: isNull(customerContacts.deletedAt) },
        deliveryAddresses: { where: isNull(customerDeliveryAddresses.deletedAt) },
        invoiceAddresses: { where: isNull(customerInvoiceAddresses.deletedAt) },
        notes: { where: isNull(customerNotes.deletedAt), orderBy: (n, { desc }) => [desc(n.createdAt)] },
        productPrices: { where: isNull(customerProductPrices.deletedAt) },
      },
    });
  }

  // ================================================================
  // Get by email (for duplicate checking and integrations)
  // ================================================================

  async getByEmail(email: string, companyId: string) {
    return this.db.query.customers.findFirst({
      where: and(eq(customers.email, email), eq(customers.companyId, companyId), isNull(customers.deletedAt)),
    });
  }

  // ================================================================
  // Create
  // ================================================================

  async create(companyId: string, input: CreateCustomerInput) {
    // Email uniqueness check (mirrors old GetByCustomerEmail)
    if (input.email) {
      const existing = await this.getByEmail(input.email, companyId);
      if (existing) {
        throw new CustomerValidationError(`Email "${input.email}" already taken`);
      }
    }

    const [customer] = await this.db
      .insert(customers)
      .values({
        companyId,
        name: input.name,
        shortName: input.shortName,
        typeId: input.typeId,
        email: input.email,
        creditLimit: (input.creditLimit ?? 0).toString(),
        creditCurrencyCode: input.creditCurrencyCode ?? 'GBP',
        creditTermDays: input.creditTermDays ?? 30,
        taxRatePercent: (input.taxRatePercent ?? 20).toString(),
        vatTreatment: input.vatTreatment,
        vatRegistrationNumber: input.vatRegistrationNumber,
        companyRegistrationNumber: input.companyRegistrationNumber,
        countryCode: input.countryCode,
        defaultRevenueAccountCode: input.defaultRevenueAccountCode,
        warehouseId: input.warehouseId,
      })
      .returning();
    return customer;
  }

  // ================================================================
  // Update
  // ================================================================

  async update(id: string, companyId: string, input: UpdateCustomerInput) {
    if (input.email) {
      const dup = await this.getByEmail(input.email, companyId);
      if (dup && dup.id !== id) {
        throw new CustomerValidationError(`Email "${input.email}" already taken`);
      }
    }

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
      .update(customers)
      .set(updateData)
      .where(and(eq(customers.id, id), eq(customers.companyId, companyId), isNull(customers.deletedAt)))
      .returning();
    return updated;
  }

  // ================================================================
  // Soft Delete
  // ================================================================

  async delete(id: string, companyId: string) {
    const result = await this.db
      .update(customers)
      .set({ deletedAt: new Date() })
      .where(and(eq(customers.id, id), eq(customers.companyId, companyId), isNull(customers.deletedAt)));
    return (result.rowCount ?? 0) > 0;
  }

  // ================================================================
  // Contacts
  // ================================================================

  async addContact(customerId: string, input: Record<string, unknown>) {
    const [contact] = await this.db.insert(customerContacts).values({ customerId, ...input } as any).returning();
    return contact;
  }

  async updateContact(contactId: string, input: Record<string, unknown>) {
    const [updated] = await this.db
      .update(customerContacts)
      .set({ ...input, updatedAt: new Date() } as any)
      .where(and(eq(customerContacts.id, contactId), isNull(customerContacts.deletedAt)))
      .returning();
    return updated;
  }

  async deleteContact(contactId: string) {
    const result = await this.db
      .update(customerContacts)
      .set({ deletedAt: new Date() })
      .where(and(eq(customerContacts.id, contactId), isNull(customerContacts.deletedAt)));
    return (result.rowCount ?? 0) > 0;
  }

  // ================================================================
  // Delivery Addresses
  // ================================================================

  async addDeliveryAddress(customerId: string, input: Record<string, unknown>) {
    const [addr] = await this.db.insert(customerDeliveryAddresses).values({ customerId, ...input } as any).returning();
    return addr;
  }

  async updateDeliveryAddress(addressId: string, input: Record<string, unknown>) {
    const [updated] = await this.db
      .update(customerDeliveryAddresses)
      .set({ ...input, updatedAt: new Date() } as any)
      .where(and(eq(customerDeliveryAddresses.id, addressId), isNull(customerDeliveryAddresses.deletedAt)))
      .returning();
    return updated;
  }

  async deleteDeliveryAddress(addressId: string) {
    const result = await this.db
      .update(customerDeliveryAddresses)
      .set({ deletedAt: new Date() })
      .where(and(eq(customerDeliveryAddresses.id, addressId), isNull(customerDeliveryAddresses.deletedAt)));
    return (result.rowCount ?? 0) > 0;
  }

  // ================================================================
  // Invoice Addresses
  // ================================================================

  async addInvoiceAddress(customerId: string, input: Record<string, unknown>) {
    const [addr] = await this.db.insert(customerInvoiceAddresses).values({ customerId, ...input } as any).returning();
    return addr;
  }

  async updateInvoiceAddress(addressId: string, input: Record<string, unknown>) {
    const [updated] = await this.db
      .update(customerInvoiceAddresses)
      .set({ ...input, updatedAt: new Date() } as any)
      .where(and(eq(customerInvoiceAddresses.id, addressId), isNull(customerInvoiceAddresses.deletedAt)))
      .returning();
    return updated;
  }

  async deleteInvoiceAddress(addressId: string) {
    const result = await this.db
      .update(customerInvoiceAddresses)
      .set({ deletedAt: new Date() })
      .where(and(eq(customerInvoiceAddresses.id, addressId), isNull(customerInvoiceAddresses.deletedAt)));
    return (result.rowCount ?? 0) > 0;
  }

  // ================================================================
  // Notes
  // ================================================================

  async addNote(customerId: string, userId: string, input: { note: string; attachmentUrl?: string; isMarked?: boolean }) {
    const [noteRow] = await this.db.insert(customerNotes).values({ customerId, userId, ...input }).returning();
    return noteRow;
  }

  async updateNote(noteId: string, input: { note?: string; isMarked?: boolean }) {
    const [updated] = await this.db
      .update(customerNotes)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(customerNotes.id, noteId), isNull(customerNotes.deletedAt)))
      .returning();
    return updated;
  }

  // ================================================================
  // Customer Types
  // ================================================================

  async listTypes(companyId: string) {
    return this.db.query.customerTypes.findMany({
      where: and(eq(customerTypes.companyId, companyId), isNull(customerTypes.deletedAt)),
      orderBy: (t, { asc }) => [asc(t.name)],
    });
  }

  async createType(companyId: string, name: string, isDefault: boolean) {
    if (isDefault) {
      await this.db.update(customerTypes)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(and(eq(customerTypes.companyId, companyId), eq(customerTypes.isDefault, true)));
    }
    const [type] = await this.db.insert(customerTypes).values({ companyId, name, isDefault }).returning();
    return type;
  }

  async updateType(typeId: string, companyId: string, input: { name?: string; isDefault?: boolean }) {
    const [updated] = await this.db
      .update(customerTypes)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(customerTypes.id, typeId), eq(customerTypes.companyId, companyId)))
      .returning();
    return updated;
  }

  async deleteType(typeId: string, companyId: string) {
    const result = await this.db
      .update(customerTypes)
      .set({ deletedAt: new Date() })
      .where(and(eq(customerTypes.id, typeId), eq(customerTypes.companyId, companyId), isNull(customerTypes.deletedAt)));
    return (result.rowCount ?? 0) > 0;
  }

  // ================================================================
  // Customer Product Prices
  // ================================================================

  async setProductPrice(companyId: string, customerId: string, productId: string, price: number) {
    // Upsert — delete existing then insert
    await this.db
      .update(customerProductPrices)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(customerProductPrices.companyId, companyId),
          eq(customerProductPrices.customerId, customerId),
          eq(customerProductPrices.productId, productId),
          isNull(customerProductPrices.deletedAt),
        ),
      );

    const [row] = await this.db
      .insert(customerProductPrices)
      .values({ companyId, customerId, productId, price: price.toString() })
      .returning();
    return row;
  }

  async removeProductPrice(companyId: string, customerId: string, productId: string) {
    const result = await this.db
      .update(customerProductPrices)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(customerProductPrices.companyId, companyId),
          eq(customerProductPrices.customerId, customerId),
          eq(customerProductPrices.productId, productId),
          isNull(customerProductPrices.deletedAt),
        ),
      );
    return (result.rowCount ?? 0) > 0;
  }
}

export class CustomerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomerValidationError';
  }
}
