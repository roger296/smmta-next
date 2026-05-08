/**
 * POST /api/checkout/start — turn the cart into a Mollie payment.
 *
 * Returns `{ checkoutUrl }` on success — the storefront page redirects
 * the customer to Mollie. Failure modes:
 *
 *   400  bad input
 *   404  no cart cookie / empty cart
 *   409  INSUFFICIENT_STOCK (with productId + available)
 *   500  EMPTY_CART or PAYMENT_CREATE_FAILED
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { readCartIdFromCookie } from '@/lib/cookies';
import { startCheckout } from '@/lib/checkout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const addressSchema = z.object({
  line1: z.string().min(1).max(255),
  line2: z.string().max(255).optional(),
  city: z.string().min(1).max(100),
  region: z.string().max(100).optional(),
  postCode: z.string().min(1).max(50),
  country: z.string().min(1).max(50),
  contactName: z.string().max(100).optional(),
});

const bodySchema = z.object({
  customer: z.object({
    email: z.string().email().max(100),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    phone: z.string().max(50).optional(),
  }),
  deliveryAddress: addressSchema,
  invoiceAddress: addressSchema.optional(),
  termsAccepted: z.literal(true, {
    errorMap: () => ({ message: 'Terms and conditions must be accepted' }),
  }),
});

export async function POST(request: NextRequest) {
  const cartId = await readCartIdFromCookie();
  if (!cartId) {
    return NextResponse.json({ error: 'No cart' }, { status: 404 });
  }

  const raw = await request.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const result = await startCheckout({
    cartId,
    customer: parsed.data.customer,
    deliveryAddress: parsed.data.deliveryAddress,
    invoiceAddress: parsed.data.invoiceAddress,
  });

  if (result.ok) {
    return NextResponse.json(
      { checkoutId: result.checkoutId, checkoutUrl: result.checkoutUrl },
      { status: 201 },
    );
  }
  if (result.error === 'EMPTY_CART') {
    return NextResponse.json({ error: 'EMPTY_CART' }, { status: 404 });
  }
  if (result.error === 'INSUFFICIENT_STOCK') {
    return NextResponse.json(
      {
        error: 'INSUFFICIENT_STOCK',
        productId: result.productId,
        available: result.available,
        requested: result.requested,
      },
      { status: 409 },
    );
  }
  return NextResponse.json(
    { error: 'PAYMENT_CREATE_FAILED', reason: result.reason },
    { status: 502 },
  );
}
