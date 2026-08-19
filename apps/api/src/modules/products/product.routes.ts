import type { FastifyInstance } from 'fastify';
import { requireAuth, getAuthUser } from '../../shared/middleware/auth.js';
import { hasRole } from '../../shared/middleware/require-role.js';
import { ProductInUseError, ProductService, ProductValidationError } from './product.service.js';
import { NeedsSetupService } from './needs-setup.service.js';
import { z } from 'zod';
import {
  createProductSchema,
  updateProductSchema,
  productQuerySchema,
  productImageSchema,
} from './product.schema.js';

const productService = new ProductService();
const needsSetupService = new NeedsSetupService();

const attachBarcodeSchema = z.object({
  barcode: z.string().trim().min(1).max(64),
});

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

  // ── GET /products/needs-setup ─────────────────────────────────
  // Every stocked product not ready for a venue to receive (C-1/C-2/C-4).
  // Registered before /products/:id so the static segment is unambiguous.
  app.get('/products/needs-setup', async (request) => {
    const user = getAuthUser(request);
    const [rows, summary] = await Promise.all([
      needsSetupService.list(user.companyId),
      needsSetupService.summary(user.companyId),
    ]);
    // `{ rows, summary }` inside `data`, not alongside it: the envelope's
    // sibling keys are reserved for pagination, and `apiFetch` unwraps `data`.
    return { success: true, data: { rows, summary } };
  });

  // ── GET /products/by-code/:code ───────────────────────────────
  // Unambiguous single-product resolution for a scan (defect C-3). Distinct
  // from /products?search= on purpose: a scan wants one answer or none, not a
  // relevance-ordered page it then has to guess from.
  app.get('/products/by-code/:code', async (request, reply) => {
    const user = getAuthUser(request);
    const { code } = request.params as { code: string };
    const product = await productService.findByCode(user.companyId, code);
    if (!product) {
      return reply
        .status(404)
        .send({ success: false, error: `No product carries the code "${code}".` });
    }
    return { success: true, data: product };
  });

  // ── POST /products/:id/barcode ────────────────────────────────
  // Attach a scanned code to an existing product, so the next delivery scans
  // first time (defect C-3). A code already held elsewhere is a 409, never a
  // silent overwrite.
  app.post('/products/:id/barcode', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const parsed = attachBarcodeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', details: parsed.error.issues });
    }
    try {
      const product = await productService.attachBarcode(user.companyId, id, parsed.data.barcode);
      if (!product) return reply.status(404).send({ success: false, error: 'Product not found' });
      return { success: true, data: product };
    } catch (err) {
      if (err instanceof ProductValidationError) {
        return reply.status(409).send({ success: false, error: err.message });
      }
      throw err;
    }
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
      // Editing a cost is `site_manager`+ (E-4, locked decision 5). Guarded
      // here rather than with a blanket `requireRole` on the route, because a
      // head baker legitimately edits other product fields — it is the PRICE
      // that moves money, and the tester specifically could not reach it.
      if (input.expectedNextCost !== undefined && !hasRole(user, ['site_manager'])) {
        return reply.status(403).send({
          success: false,
          error: 'Changing a cost needs a site manager. Ask one to set the price.',
        });
      }
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
    try {
      const deleted = await productService.delete(id, user.companyId);
      if (!deleted) return reply.status(404).send({ success: false, error: 'Product not found' });
      return { success: true, message: 'Product deleted' };
    } catch (err) {
      // 409, not 500: the request was well-formed and the server is fine — the
      // product is simply still in use. The detail rides along so the UI can
      // show where the stock is and which recipes use it, rather than making
      // someone check five sites and every recipe by hand.
      if (err instanceof ProductInUseError) {
        return reply.status(409).send({
          success: false,
          error: err.message,
          details: { stock: err.stock, recipes: err.recipeUses },
        });
      }
      throw err;
    }
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
