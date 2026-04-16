import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { requireAuth, getAuthUser } from '../../shared/middleware/auth.js';
import { CategoryService } from './category.service.js';
import { ManufacturerService } from './manufacturer.service.js';
import { WarehouseService } from './warehouse.service.js';

const categoryService = new CategoryService();
const manufacturerService = new ManufacturerService();
const warehouseService = new WarehouseService();

const categorySchema = z.object({ name: z.string().min(1).max(200) });

const manufacturerSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  logoUrl: z.string().url().optional(),
  website: z.string().url().optional(),
  customerSupportPhone: z.string().optional(),
  customerSupportEmail: z.string().email().optional(),
  techSupportPhone: z.string().optional(),
  techSupportEmail: z.string().email().optional(),
});

const warehouseSchema = z.object({
  name: z.string().min(1).max(200),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  postCode: z.string().optional(),
  country: z.string().optional(),
  isDefault: z.boolean().optional(),
});

export async function referenceRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // ═══════════════════════════════════════════════════════════════
  // CATEGORIES
  // ═══════════════════════════════════════════════════════════════

  app.get('/categories', async (request) => {
    const user = getAuthUser(request);
    const { search } = request.query as { search?: string };
    const data = await categoryService.list(user.companyId, search);
    return { success: true, data };
  });

  app.get('/categories/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const data = await categoryService.getById(id, user.companyId);
    if (!data) return reply.status(404).send({ success: false, error: 'Category not found' });
    return { success: true, data };
  });

  app.post('/categories', async (request, reply) => {
    const user = getAuthUser(request);
    const { name } = categorySchema.parse(request.body);
    const data = await categoryService.create(user.companyId, name);
    return reply.status(201).send({ success: true, data });
  });

  app.put('/categories/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const { name } = categorySchema.parse(request.body);
    const data = await categoryService.update(id, user.companyId, name);
    if (!data) return reply.status(404).send({ success: false, error: 'Category not found' });
    return { success: true, data };
  });

  app.delete('/categories/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const deleted = await categoryService.delete(id, user.companyId);
    if (!deleted) return reply.status(404).send({ success: false, error: 'Category not found' });
    return { success: true, message: 'Category deleted' };
  });

  // Category ↔ Product mapping
  app.post('/categories/:categoryId/products/:productId', async (request, reply) => {
    const { categoryId, productId } = request.params as { categoryId: string; productId: string };
    const data = await categoryService.assignProductToCategory(productId, categoryId);
    return reply.status(201).send({ success: true, data });
  });

  app.delete('/categories/:categoryId/products/:productId', async (request, reply) => {
    const { categoryId, productId } = request.params as { categoryId: string; productId: string };
    const removed = await categoryService.removeProductFromCategory(productId, categoryId);
    if (!removed) return reply.status(404).send({ success: false, error: 'Mapping not found' });
    return { success: true, message: 'Product removed from category' };
  });

  // ═══════════════════════════════════════════════════════════════
  // MANUFACTURERS
  // ═══════════════════════════════════════════════════════════════

  app.get('/manufacturers', async (request) => {
    const { search } = request.query as { search?: string };
    const data = await manufacturerService.list(search);
    return { success: true, data };
  });

  app.get('/manufacturers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = await manufacturerService.getById(id);
    if (!data) return reply.status(404).send({ success: false, error: 'Manufacturer not found' });
    return { success: true, data };
  });

  app.post('/manufacturers', async (request, reply) => {
    const input = manufacturerSchema.parse(request.body);
    const data = await manufacturerService.create(input);
    return reply.status(201).send({ success: true, data });
  });

  app.put('/manufacturers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = manufacturerSchema.partial().parse(request.body);
    const data = await manufacturerService.update(id, input);
    if (!data) return reply.status(404).send({ success: false, error: 'Manufacturer not found' });
    return { success: true, data };
  });

  app.delete('/manufacturers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = await manufacturerService.delete(id);
    if (!deleted) return reply.status(404).send({ success: false, error: 'Manufacturer not found' });
    return { success: true, message: 'Manufacturer deleted' };
  });

  // ═══════════════════════════════════════════════════════════════
  // WAREHOUSES
  // ═══════════════════════════════════════════════════════════════

  app.get('/warehouses', async (request) => {
    const user = getAuthUser(request);
    const data = await warehouseService.list(user.companyId);
    return { success: true, data };
  });

  app.get('/warehouses/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const data = await warehouseService.getById(id, user.companyId);
    if (!data) return reply.status(404).send({ success: false, error: 'Warehouse not found' });
    return { success: true, data };
  });

  app.post('/warehouses', async (request, reply) => {
    const user = getAuthUser(request);
    const input = warehouseSchema.parse(request.body);
    const data = await warehouseService.create(user.companyId, input);
    return reply.status(201).send({ success: true, data });
  });

  app.put('/warehouses/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const input = warehouseSchema.partial().parse(request.body);
    const data = await warehouseService.update(id, user.companyId, input);
    if (!data) return reply.status(404).send({ success: false, error: 'Warehouse not found' });
    return { success: true, data };
  });

  app.delete('/warehouses/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const deleted = await warehouseService.delete(id, user.companyId);
    if (!deleted) return reply.status(404).send({ success: false, error: 'Warehouse not found' });
    return { success: true, message: 'Warehouse deleted' };
  });
}
