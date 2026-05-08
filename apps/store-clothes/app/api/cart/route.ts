/**
 * /api/cart — read + add.
 *
 *   GET  /api/cart        → JSON with the current cart view.
 *   POST /api/cart        → add a line item.
 *
 * The POST handler accepts both JSON (`Content-Type: application/json`) and
 * form-urlencoded bodies. Form submissions get a 303 redirect back to
 * `/cart` (or the `redirect` form field if supplied) for a no-JS fallback.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { addItem, CartError, getOrCreateCart } from '@/lib/cart';
import { readCartIdFromCookie, writeCartCookie } from '@/lib/cookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const cartId = await readCartIdFromCookie();
  const view = await getOrCreateCart(cartId);
  return NextResponse.json(view);
}

const addItemBodySchema = z.object({
  productId: z.string().uuid(),
  quantity: z.coerce.number().int().min(1).max(99).default(1),
  redirect: z.string().optional(),
});

async function parseBody(request: NextRequest) {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return await request.json().catch(() => ({}));
  }
  // Treat everything else as form-encoded — multipart and url-encoded both
  // resolve via formData().
  const fd = await request.formData();
  return Object.fromEntries(fd.entries());
}

export async function POST(request: NextRequest) {
  const body = await parseBody(request);
  const parsed = addItemBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const cartId = await readCartIdFromCookie();
  try {
    const result = await addItem(cartId, parsed.data.productId, parsed.data.quantity);
    // Persist the cookie if this was a fresh cart.
    if (result.cartId !== cartId) {
      await writeCartCookie(result.cartId);
    }

    const wantsHtml =
      request.headers.get('accept')?.includes('text/html') ?? false;
    if (wantsHtml || parsed.data.redirect) {
      // Form-submission fallback — bounce back to a sensible page.
      const redirectTo = parsed.data.redirect ?? '/cart';
      return NextResponse.redirect(new URL(redirectTo, request.url), { status: 303 });
    }
    return NextResponse.json(result.cart, { status: 201 });
  } catch (err) {
    if (err instanceof CartError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    throw err;
  }
}
