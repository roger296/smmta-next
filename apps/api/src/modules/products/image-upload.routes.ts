/**
 * Product image uploads.
 *
 * Until now the only way to attach a picture was to paste a URL, which assumes
 * the operator has already hosted it somewhere. Photographs of stock come off a
 * phone or a camera, so the common case had no path at all.
 *
 * Files are written to a directory on disk (UPLOADS_DIR) and served back from
 * /uploads. That deliberately avoids an object-store dependency: this project
 * is meant to be self-hosted from `docker compose up`, and requiring an S3
 * account to attach a photograph would undercut that. The directory must be a
 * mounted volume in production — a container filesystem does not survive a
 * redeploy, and the images would vanish on the next one.
 *
 * The stored URL is absolute, built from APP_BASE_URL, because the storefront
 * renders it from a different origin than the API.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { getEnv } from '../../config/env.js';
import { requireAuth, getAuthUser } from '../../shared/middleware/auth.js';
import { ProductService } from './product.service.js';

const productService = new ProductService();

/** 8 MB. Comfortably fits a phone photograph; refuses a video by mistake. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Accepted image types, mapped to the extension we save under.
 *
 * An allow-list rather than a check for "image/*": the extension is derived
 * from this map rather than from the client's filename, so a request cannot
 * choose what lands on disk. SVG is deliberately excluded — it can carry
 * script, and these files are served from our own origin.
 */
export const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/gif': '.gif',
};

/** Where uploads live. Relative paths resolve against the process cwd. */
export function uploadsDir(): string {
  return process.env.UPLOADS_DIR || './uploads';
}

/** Public URL for a stored file. */
export function publicUrlFor(filename: string): string {
  const base = getEnv().APP_BASE_URL.replace(/\/$/, '');
  return `${base}/uploads/${filename}`;
}

export async function productImageUploadRoutes(app: FastifyInstance) {
  // This lives in its own plugin because it needs the multipart body parser,
  // and a Fastify hook added inside productRoutes does not reach here — a
  // separate registration is a separate encapsulation context. Omitting this
  // would leave an unauthenticated write-to-disk endpoint exposed.
  app.addHook('preHandler', requireAuth);

  app.post('/products/:id/images/upload', async (request, reply) => {
    const user = getAuthUser(request);
    const { id: productId } = request.params as { id: string };

    // Check the product first: writing the file before knowing it has anywhere
    // to belong leaves litter on disk for every bad id someone tries.
    const product = await productService.getById(productId, user.companyId);
    if (!product) {
      return reply.status(404).send({ success: false, error: 'Product not found' });
    }

    const file = await (request as unknown as {
      file: (opts?: unknown) => Promise<
        | { filename: string; mimetype: string; toBuffer: () => Promise<Buffer>; file: { truncated: boolean } }
        | undefined
      >;
    }).file({ limits: { fileSize: MAX_UPLOAD_BYTES } });

    if (!file) {
      return reply.status(400).send({ success: false, error: 'No file supplied' });
    }

    const ext = ALLOWED_IMAGE_TYPES[file.mimetype];
    if (!ext) {
      return reply.status(415).send({
        success: false,
        error: `Unsupported image type "${file.mimetype}". Allowed: ${Object.keys(ALLOWED_IMAGE_TYPES).join(', ')}`,
      });
    }

    const buffer = await file.toBuffer();
    // busboy truncates rather than throwing, so an oversized file arrives
    // silently clipped. Reject it instead of storing a corrupt image.
    if (file.file.truncated || buffer.length > MAX_UPLOAD_BYTES) {
      return reply.status(413).send({
        success: false,
        error: `File exceeds the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit`,
      });
    }

    // Name the file ourselves. The client's filename never touches the path,
    // so "../../etc/passwd" has nowhere to go.
    const filename = `${randomUUID()}${ext}`;
    const dir = uploadsDir();
    await mkdir(dir, { recursive: true });
    const target = join(dir, filename);
    await writeFile(target, buffer);

    try {
      const priorityRaw = (request.query as { priority?: string } | undefined)?.priority;
      const priority = Number.isFinite(Number(priorityRaw)) ? Number(priorityRaw) : 0;
      const image = await productService.addImage(productId, publicUrlFor(filename), priority);
      return reply.status(201).send({ success: true, data: image });
    } catch (err) {
      // The row is what makes the file reachable; without it the file is
      // unreferenced litter. Remove it so a failed upload leaves nothing.
      await unlink(target).catch(() => undefined);
      throw err;
    }
  });
}

/** Extension for a stored filename, used by the static route's content type. */
export function extensionOf(filename: string): string {
  return extname(filename).toLowerCase();
}
