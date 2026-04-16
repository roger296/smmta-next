import type { FastifyInstance } from 'fastify';
import { requireAuth, getAuthUser } from '../../shared/middleware/auth.js';
import { SupplierService } from './supplier.service.js';
import {
  createSupplierSchema, updateSupplierSchema, supplierQuerySchema,
  supplierContactSchema, supplierAddressSchema, supplierNoteSchema,
} from './supplier.schema.js';

const supplierService = new SupplierService();

export async function supplierRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // ── Suppliers CRUD ────────────────────────────────────────────

  app.get('/suppliers', async (request) => {
    const user = getAuthUser(request);
    const query = supplierQuerySchema.parse(request.query);
    const result = await supplierService.list(user.companyId, query);
    return { success: true, ...result };
  });

  app.get('/suppliers/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const data = await supplierService.getById(id, user.companyId);
    if (!data) return reply.status(404).send({ success: false, error: 'Supplier not found' });
    return { success: true, data };
  });

  app.post('/suppliers', async (request, reply) => {
    const user = getAuthUser(request);
    const input = createSupplierSchema.parse(request.body);
    const data = await supplierService.create(user.companyId, input);
    return reply.status(201).send({ success: true, data });
  });

  app.put('/suppliers/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const input = updateSupplierSchema.parse(request.body);
    const data = await supplierService.update(id, user.companyId, input);
    if (!data) return reply.status(404).send({ success: false, error: 'Supplier not found' });
    return { success: true, data };
  });

  app.delete('/suppliers/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const deleted = await supplierService.delete(id, user.companyId);
    if (!deleted) return reply.status(404).send({ success: false, error: 'Supplier not found' });
    return { success: true, message: 'Supplier deleted' };
  });

  // ── Contacts ──────────────────────────────────────────────────

  app.post('/suppliers/:id/contacts', async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = supplierContactSchema.parse(request.body);
    const data = await supplierService.addContact(id, input);
    return reply.status(201).send({ success: true, data });
  });

  app.put('/suppliers/:id/contacts/:contactId', async (request, reply) => {
    const { contactId } = request.params as { contactId: string };
    const input = supplierContactSchema.partial().parse(request.body);
    const data = await supplierService.updateContact(contactId, input);
    if (!data) return reply.status(404).send({ success: false, error: 'Contact not found' });
    return { success: true, data };
  });

  app.delete('/suppliers/:id/contacts/:contactId', async (request, reply) => {
    const { contactId } = request.params as { contactId: string };
    const deleted = await supplierService.deleteContact(contactId);
    if (!deleted) return reply.status(404).send({ success: false, error: 'Contact not found' });
    return { success: true, message: 'Contact deleted' };
  });

  // ── Addresses ─────────────────────────────────────────────────

  app.post('/suppliers/:id/addresses', async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = supplierAddressSchema.parse(request.body);
    const data = await supplierService.addAddress(id, input);
    return reply.status(201).send({ success: true, data });
  });

  app.put('/suppliers/:id/addresses/:addressId', async (request, reply) => {
    const { addressId } = request.params as { addressId: string };
    const input = supplierAddressSchema.partial().parse(request.body);
    const data = await supplierService.updateAddress(addressId, input);
    if (!data) return reply.status(404).send({ success: false, error: 'Address not found' });
    return { success: true, data };
  });

  app.delete('/suppliers/:id/addresses/:addressId', async (request, reply) => {
    const { addressId } = request.params as { addressId: string };
    const deleted = await supplierService.deleteAddress(addressId);
    if (!deleted) return reply.status(404).send({ success: false, error: 'Address not found' });
    return { success: true, message: 'Address deleted' };
  });

  // ── Notes ─────────────────────────────────────────────────────

  app.post('/suppliers/:id/notes', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const input = supplierNoteSchema.parse(request.body);
    const data = await supplierService.addNote(id, user.userId, input);
    return reply.status(201).send({ success: true, data });
  });

  app.put('/suppliers/:id/notes/:noteId', async (request, reply) => {
    const { noteId } = request.params as { noteId: string };
    const input = supplierNoteSchema.partial().parse(request.body);
    const data = await supplierService.updateNote(noteId, input);
    if (!data) return reply.status(404).send({ success: false, error: 'Note not found' });
    return { success: true, data };
  });
}
