/**
 * GET /cart/add?t=<signed token> — the one-click "add to basket" link in our
 * emails. The API checks the token and names the exact variant and quantity;
 * this adds it to the visitor's basket (creating one if needed) and shows the
 * basket. It grants no account access. A stale or tampered link lands on the
 * basket with a note instead of an error page.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { addItem, CartError } from '@/lib/cart';
import { readCartIdFromCookie, writeCartCookie } from '@/lib/cookies';
import { resolveEmailCartLink } from '@/lib/smmta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('t') ?? '';
  const target = new URL('/cart', request.url);
  // Keep the email's tracking on the landing page so analytics sees it.
  for (const [k, v] of request.nextUrl.searchParams) if (k !== 't') target.searchParams.set(k, v);

  if (!token) return NextResponse.redirect(target, { status: 303 });
  try {
    const { productId, quantity } = await resolveEmailCartLink(token);
    const cartId = await readCartIdFromCookie();
    const result = await addItem(cartId, productId, quantity);
    if (result.cartId !== cartId) await writeCartCookie(result.cartId);
  } catch (err) {
    if (!(err instanceof CartError)) {
      // Expired / tampered link or the API is unreachable: still land them
      // on their basket, with a note the page can show.
      target.searchParams.set('link', 'expired');
    } else {
      target.searchParams.set('link', 'unavailable');
    }
  }
  return NextResponse.redirect(target, { status: 303 });
}
