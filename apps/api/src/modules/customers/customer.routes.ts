import type { FastifyInstance } from 'fastify';
import { requireAuth, getAuthUser } from '../../shared/middleware/auth.js';
import { CustomerService, CustomerValidationError } from './customer.service.js';
import {
  createCustomerSchema, updateCustomerSchema, customerQuerySchema,
  customerContactSchema, customerAddressSchema, customerInvoiceAddressSchema,
  customerNoteSchema, customerProductPriceSchema, customerTypeSchema,
} from './customer.schema.js';

const customerService = new CustomerService();

export async function customerRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // ═══════════════════════════════════════════════════════════════
  // CUSTOMERS CRUD
  // ═══════════════════════════════════════════════════════════════

  app.get('/customers', async (request) => {
    const user = getAuthUser(request);
    const query = customerQuerySchema.parse(request.query);
    return { success: true, ...await customerService.list(user.companyId, query) };
  });

  app.get('/customers/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const data = await customerService.getById(id, user.companyId);
    if (!data) return reply.status(404).send({ success: false, error: 'Customer not found' });
    return { success: true, data };
  });

  app.post('/customers', async (request, reply) => {
    const user = getAuthUser(request);
    try {
      const input = createCustomerSchema.parse(request.body);
      const data = await customerService.create(user.companyId, input);
      return reply.status(201).send({ success: true, data });
    } catch (err) {
      if (err instanceof CustomerValidationError) return reply.status(409).send({ success: false, error: err.message });
      throw err;
    }
  });

  app.put('/customers/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    try {
      const input = updateCustomerSchema.parse(request.body);
      const data = await customerService.update(id, user.companyId, input);
      if (!data) return reply.status(404).send({ success: false, error: 'Customer not found' });
      return { success: true, data };
    } catch (err) {
      if (err instanceof CustomerValidationError) return reply.status(409).send({ success: false, error: err.message });
      throw err;
    }
  });

  app.delete('/customers/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const deleted = await customerService.delete(id, user.companyId);
    if (!deleted) return reply.status(404).send({ success: false, error: 'Customer not found' });
    return { success: true, message: 'Customer deleted' };
  });

  // ═══════════════════════════════════════════════════════════════
  // CONTACTS
  // ═══════════════════════════════════════════════════════════════

  app.post('/customers/:id/contacts', async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = customerContactSchema.parse(request.body);
    return reply.status(201).send({ success: true, data: await customerService.addContact(id, input) });
  });

  app.put('/customers/:id/contacts/:contactId', async (request, reply) => {
    const { contactId } = request.params as { contactId: string };
    const input = customerContactSchema.partial().parse(request.body);
    const data = await customerService.updateContact(contactId, input);
    if (!data) return reply.status(404).send({ success: false, error: 'Contact not found' });
    return { success: true, data };
  });

  app.delete('/customers/:id/contacts/:contactId', async (request, reply) => {
    const { contactId } = request.params as { contactId: string };
    const ok = await customerService.deleteContact(contactId);
    if (!ok) return reply.status(404).send({ success: false, error: 'Contact not found' });
    return { success: true, message: 'Contact deleted' };
  });

  // ═══════════════════════════════════════════════════════════════
  // DELIVERY ADDRESSES
  // ═══════════════════════════════════════════════════════════════

  app.post('/customers/:id/addresses/delivery', async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = customerAddressSchema.parse(request.body);
    return reply.status(201).send({ success: true, data: await customerService.addDeliveryAddress(id, input) });
  });

  app.put('/customers/:id/addresses/delivery/:addressId', async (request, reply) => {
    const { addressId } = request.params as { addressId: string };
    const input = customerAddressSchema.partial().parse(request.body);
    const data = await customerService.updateDeliveryAddress(addressId, input);
    if (!data) return reply.status(404).send({ success: false, error: 'Address not found' });
    return { success: true, data };
  });

  app.delete('/customers/:id/addresses/delivery/:addressId', async (request, reply) => {
    const { addressId } = request.params as { addressId: string };
    const ok = await customerService.deleteDeliveryAddress(addressId);
    if (!ok) return reply.status(404).send({ success: false, error: 'Address not found' });
    return { success: true, message: 'Address deleted' };
  });

  // ═══════════════════════════════════════════════════════════════
  // INVOICE ADDRESSES
  // ═══════════════════════════════════════════════════════════════

  app.post('/customers/:id/addresses/invoice', async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = customerInvoiceAddressSchema.parse(request.body);
    return reply.status(201).send({ success: true, data: await customerService.addInvoiceAddress(id, input) });
  });

  app.put('/customers/:id/addresses/invoice/:addressId', async (request, reply) => {
    const { addressId } = request.params as { addressId: string };
    const input = customerInvoiceAddressSchema.partial().parse(request.body);
    const data = await customerService.updateInvoiceAddress(addressId, input);
    if (!data) return reply.status(404).send({ success: false, error: 'Address not found' });
    return { success: true, data };
  });

  app.delete('/customers/:id/addresses/invoice/:addressId', async (request, reply) => {
    const { addressId } = request.params as { addressId: string };
    const ok = await customerService.deleteInvoiceAddress(addressId);
    if (!ok) return reply.status(404).send({ success: false, error: 'Address not found' });
    return { success: true, message: 'Address deleted' };
  });

  // ═══════════════════════════════════════════════════════════════
  // NOTES
  // ═══════════════════════════════════════════════════════════════

  app.post('/customers/:id/notes', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const input = customerNoteSchema.parse(request.body);
    return reply.status(201).send({ success: true, data: await customerService.addNote(id, user.userId, input) });
  });

  app.put('/customers/:id/notes/:noteId', async (request, reply) => {
    const { noteId } = request.params as { noteId: string };
    const input = customerNoteSchema.partial().parse(request.body);
    const data = await customerService.updateNote(noteId, input);
    if (!data) return reply.status(404).send({ success: false, error: 'Note not found' });
    return { success: true, data };
  });

  // ═══════════════════════════════════════════════════════════════
  // CUSTOMER TYPES
  // ═══════════════════════════════════════════════════════════════

  app.get('/customer-types', async (request) => {
    const user = getAuthUser(request);
    return { success: true, data: await customerService.listTypes(user.companyId) };
  });

  app.post('/customer-types', async (request, reply) => {
    const user = getAuthUser(request);
    const { name, isDefault } = customerTypeSchema.parse(request.body);
    return reply.status(201).send({ success: true, data: await customerService.createType(user.companyId, name, isDefault) });
  });

  app.put('/customer-types/:typeId', async (request, reply) => {
    const user = getAuthUser(request);
    const { typeId } = request.params as { typeId: string };
    const input = customerTypeSchema.partial().parse(request.body);
    const data = await customerService.updateType(typeId, user.companyId, input);
    if (!data) return reply.status(404).send({ success: false, error: 'Type not found' });
    return { success: true, data };
  });

  app.delete('/customer-types/:typeId', async (request, reply) => {
    const user = getAuthUser(request);
    const { typeId } = request.params as { typeId: string };
    const ok = await customerService.deleteType(typeId, user.companyId);
    if (!ok) return reply.status(404).send({ success: false, error: 'Type not found' });
    return { success: true, message: 'Type deleted' };
  });

  // ═══════════════════════════════════════════════════════════════
  // CUSTOMER PRODUCT PRICES
  // ═══════════════════════════════════════════════════════════════

  app.post('/customers/:id/product-prices', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const { productId, price } = customerProductPriceSchema.parse(request.body);
    return reply.status(201).send({ success: true, data: await customerService.setProductPrice(user.companyId, id, productId, price) });
  });

  app.delete('/customers/:id/product-prices/:productId', async (request, reply) => {
    const user = getAuthUser(request);
    const { id, productId } = request.params as { id: string; productId: string };
    const ok = await customerService.removeProductPrice(user.companyId, id, productId);
    if (!ok) return reply.status(404).send({ success: false, error: 'Price not found' });
    return { success: true, message: 'Product price removed' };
  });
}
