/**
 * /cart/add — the add-to-basket link from emails. The API resolver and the
 * cart are mocked; this checks the route's handling.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const resolveEmailCartLink = vi.fn();
const addItem = vi.fn();
const writeCartCookie = vi.fn();
vi.mock('@/lib/smmta', () => ({ resolveEmailCartLink }));
vi.mock('@/lib/cart', () => ({
  addItem,
  CartError: class CartError extends Error {},
}));
vi.mock('@/lib/cookies', () => ({ readCartIdFromCookie: vi.fn(async () => null), writeCartCookie }));

const { GET } = await import('./route');

beforeEach(() => {
  resolveEmailCartLink.mockReset();
  addItem.mockReset();
  writeCartCookie.mockReset();
});

describe('GET /cart/add', () => {
  it('adds the variant named by the token and lands on the basket, keeping the tracking', async () => {
    resolveEmailCartLink.mockResolvedValue({ productId: 'p1', quantity: 2 });
    addItem.mockResolvedValue({ cartId: 'cart-1', cart: {} });
    const res = await GET(new NextRequest('https://shop.example.com/cart/add?t=tok&utm_source=email&eid=s1'));
    expect(addItem).toHaveBeenCalledWith(null, 'p1', 2);
    expect(writeCartCookie).toHaveBeenCalledWith('cart-1');
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/cart');
    expect(loc.searchParams.get('utm_source')).toBe('email');
    expect(loc.searchParams.get('t')).toBeNull();
  });

  it('sends a stale link to the basket with a note', async () => {
    resolveEmailCartLink.mockRejectedValue(new Error('410'));
    const res = await GET(new NextRequest('https://shop.example.com/cart/add?t=old'));
    expect(addItem).not.toHaveBeenCalled();
    expect(new URL(res.headers.get('location')!).searchParams.get('link')).toBe('expired');
  });
});
