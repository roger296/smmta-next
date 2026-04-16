import type { FastifyInstance } from 'fastify';
import { requireAuth, getAuthUser } from '../../shared/middleware/auth.js';
import { ProductService, ProductValidationError } from './product.service.js';
import {
  createProductSchema,
  updateProductSchema,
  productQuerySchema,
  productImageSchema,
} from './product.schema.js';

const productService = new ProductService();

export async function productRoutes(app: FastifyInstance) {
  // All routes require auth
  app.addHook('preHandler', requireAuth);

  // ── GET /products ─────────────────────────────────────────────
  app.get('/products', async (request, reply) => {
    const user = getAuthUser(request);
    const query = productQuerySchema.parse(request.query);
    const result = await productService.list(user.companyId, query);
    return { success: true, ...result };
  });

  // ── GET /products/:id ─────────────────────────────────────────
  app.get('/products/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const product = await productService.getById(id, user.companyId);
    if (!product) return reply.status(404).send({ success: false, error: 'Product not found' });
    return { success: true, data: product };
  });

  // ── POST /products ────────────────────────────────────────────
  app.post('/products', async (request, reply) => {
    const user = getAuthUser(request);
    try {
      const input = createProductSchema.parse(request.body);
      const product = await productService.create(user.companyId, input);
      return reply.status(201).send({ success: true, data: product });
    } catch (err) {
      if (err instanceof ProductValidationError) {
        return reply.status(409).send({ success: false, error: err.message });
      }
      throw err;
    }
  });

  // ── PUT /products/:id ─────────────────────────────────────────
  app.put('/products/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    try {
      const input = updateProductSchema.parse(request.body);
      const product = await productService.update(id, user.companyId, input);
      if (!product) return reply.status(404).send({ success: false, error: 'Product not found' });
      return { success: true, data: product };
    } catch (err) {
      if (err instanceof ProductValidationError) {
        return reply.status(409).send({ success: false, error: err.message });
      }
      throw err;
    }
  });

  // ── DELETE /products/:id ──────────────────────────────────────
  app.delete('/products/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const deleted = await productService.delete(id, user.companyId);
    if (!deleted) return reply.status(404).send({ success: false, error: 'Product not found' });
    return { success: true, message: 'Product deleted' };
  });

  // ── GET /products/:id/stock ───────────────────────────────────
  app.get('/products/:id/stock-level', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const levels = await productService.getStockLevel(id, user.companyId);
    return { success: true, data: levels };
  });

  // ── POST /products/:id/images ─────────────────────────────────
  app.post('/products/:id/images', async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = productImageSchema.parse(request.body);
    const image = await productService.addImage(id, input.imageUrl, input.priority);
    return reply.status(201).send({ success: true, data: image });
  });

  // ── DELETE /products/:id/images/:imageId ──────────────────────
  app.delete('/products/:id/images/:imageId', async (request, reply) => {
    const { imageId } = request.params as { imageId: string };
    const deleted = await productService.removeImage(imageId);
    if (!deleted) return reply.status(404).send({ success: false, error: 'Image not found' });
    return { success: true, message: 'Image removed' };
  });

  // ── GET /products/:id/images ──────────────────────────────────
  app.get('/products/:id/images', async (request) => {
    const { id } = request.params as { id: string };
    const images = await productService.getImages(id);
    return { success: true, data: images };
  });
}
