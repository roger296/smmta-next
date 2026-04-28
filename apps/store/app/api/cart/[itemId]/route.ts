/**
 * /api/cart/[itemId] — set quantity / remove a line.
 *
 *   PATCH  /api/cart/:itemId    body { quantity }
 *   DELETE /api/cart/:itemId
 *
 * The cookie's verified cart UUID scopes both routes — a customer can't
 * patch a line they don't own because the lookup is `(cartId, itemId)`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { CartError, removeItem, setQty } from '@/lib/cart';
import { readCartIdFromCookie } from '@/lib/cookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchBodySchema = z.object({
  quantity: z.coerce.number().int().min(0).max(99),
  redirect: z.string().optional(),
});

async function parseBody(request: NextRequest): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return await request.json().catch(() => ({}));
  }
  const fd = await request.formData();
  return Object.fromEntries(fd.entries());
}

async function ensureCart(): Promise<string | NextResponse> {
  const cartId = await readCartIdFromCookie();
  if (!cartId) {
    return NextResponse.json(
      { error: 'No cart cookie present', code: 'NO_CART' },
      { status: 404 },
    );
  }
  return cartId;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> },
) {
  const cartIdOrResponse = await ensureCart();
  if (cartIdOrResponse instanceof NextResponse) return cartIdOrResponse;

  const body = await parseBody(request);
  const parsed = patchBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { itemId } = await params;

  try {
    const view = await setQty(cartIdOrResponse, itemId, parsed.data.quantity);
    if (request.headers.get('accept')?.includes('text/html') || parsed.data.redirect) {
      return NextResponse.redirect(
        new URL(parsed.data.redirect ?? '/cart', request.url),
        { status: 303 },
      );
    }
    return NextResponse.json(view);
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

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> },
) {
  const cartIdOrResponse = await ensureCart();
  if (cartIdOrResponse instanceof NextResponse) return cartIdOrResponse;
  const { itemId } = await params;
  try {
    const view = await removeItem(cartIdOrResponse, itemId);
    return NextResponse.json(view);
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
