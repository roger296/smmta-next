/**
 * Integration tests for the cart service. Hits the docker-compose Postgres
 * for `carts` / `cart_items`. The SMMTA client is mocked so the test
 * doesn't depend on the SMMTA API being up.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const PRODUCT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_PRODUCT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeefff';

// Mock the SMMTA client so addItem doesn't make real network calls.
// mockedPrice is the floor (the 10+ rate); mockedMaxPrice is the ceiling that
// a single unit costs. Null means the product does not slide, which is how
// most of these tests want it — they assert cart mechanics, not pricing.
let mockedPrice = '24.00';
let mockedMaxPrice: string | null = null;
vi.mock('./smmta', () => ({
  getProductsByIds: vi.fn(async (ids: string[]) =>
    ids.map((id) => ({
      id,
      slug: id === PRODUCT_ID ? 'aurora-smoke' : 'aurora-amber',
      colour: id === PRODUCT_ID ? 'Smoke' : 'Amber',
      colourHex: null,
      priceGbp: mockedPrice,
      maxPriceGbp: mockedMaxPrice,
      availableQty: 10,
      heroImageUrl: 'https://example.com/h.jpg',
      name: id === PRODUCT_ID ? 'Aurora — Smoke' : 'Aurora — Amber',
      shortDescription: null,
      longDescription: null,
      galleryImageUrls: null,
      seoTitle: null,
      seoDescription: null,
      seoKeywords: null,
      sortOrderInGroup: 0,
      groupId: null,
    })),
  ),
}));

// Imports happen after vi.mock so the mock is in place.
const { addItem, getOrCreateCart, removeItem, setQty, CartError } = await import('./cart');
const { closeDatabase, getDb } = await import('./db');
const { carts, cartItems } = await import('@/drizzle/schema');

beforeAll(() => {
  // Make sure the env loader is happy.
  process.env.STORE_COOKIE_SECRET = process.env.STORE_COOKIE_SECRET ?? 'cart-test-secret-32bytes-min!';
});

beforeEach(async () => {
  // Wipe the carts the previous test might have left behind. Using product
  // ids as a marker means we don't touch carts created by other suites
  // running against the same DB.
  const db = getDb();
  const dirty = await db
    .select({ cartId: cartItems.cartId })
    .from(cartItems)
    .where(inArray(cartItems.productId, [PRODUCT_ID, OTHER_PRODUCT_ID]));
  const dirtyIds = Array.from(new Set(dirty.map((r) => r.cartId)));
  if (dirtyIds.length > 0) {
    await db.delete(cartItems).where(inArray(cartItems.cartId, dirtyIds));
    await db.delete(carts).where(inArray(carts.id, dirtyIds));
  }
  mockedPrice = '24.00';
  mockedMaxPrice = null;
});

afterAll(async () => {
  await closeDatabase();
});

describe('addItem → getOrCreateCart', () => {
  it('creates a cart on first add and returns the id', async () => {
    const { cartId, cart } = await addItem(null, PRODUCT_ID, 2);
    expect(cartId).toMatch(/^[0-9a-f-]{36}$/);
    expect(cart.cartId).toBe(cartId);
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]?.quantity).toBe(2);
    expect(cart.lines[0]?.pricePerUnitGbp).toBe('24.00');
    expect(cart.subtotalGbp).toBe('48.00');
    expect(cart.itemCount).toBe(2);
  });

  // This replaces a test that asserted the OPPOSITE — that the price was
  // snapshotted at add time and later catalogue changes were ignored. Volume
  // pricing makes a per-line snapshot unworkable, because adding a tenth roll
  // of any colour has to re-price the nine already in the basket. The
  // consequence is recorded here rather than left implicit: a catalogue price
  // change now reaches carts that are already open.
  it('re-prices from the live catalogue on every read', async () => {
    const { cartId } = await addItem(null, PRODUCT_ID, 1);
    mockedPrice = '99.99';
    const view = await getOrCreateCart(cartId);
    expect(view.lines[0]?.pricePerUnitGbp).toBe('99.99');
    expect(view.subtotalGbp).toBe('99.99');
  });

  it('combines duplicate productId adds into one line', async () => {
    const { cartId } = await addItem(null, PRODUCT_ID, 1);
    const second = await addItem(cartId, PRODUCT_ID, 2);
    expect(second.cart.lines).toHaveLength(1);
    expect(second.cart.lines[0]?.quantity).toBe(3);
    expect(second.cart.subtotalGbp).toBe('72.00');
  });

  it('keeps separate lines for different productIds', async () => {
    const { cartId } = await addItem(null, PRODUCT_ID, 1);
    const second = await addItem(cartId, OTHER_PRODUCT_ID, 1);
    expect(second.cart.lines).toHaveLength(2);
    expect(second.cart.itemCount).toBe(2);
  });

  it('rejects invalid quantities (zero / negative / 100+ / non-integer)', async () => {
    await expect(addItem(null, PRODUCT_ID, 0)).rejects.toBeInstanceOf(CartError);
    await expect(addItem(null, PRODUCT_ID, -1)).rejects.toBeInstanceOf(CartError);
    await expect(addItem(null, PRODUCT_ID, 100)).rejects.toBeInstanceOf(CartError);
    await expect(addItem(null, PRODUCT_ID, 1.5)).rejects.toBeInstanceOf(CartError);
  });

  it('starts a new cart when the cookie points at a deleted one', async () => {
    const { cartId: firstId } = await addItem(null, PRODUCT_ID, 1);
    const db = getDb();
    // Simulate a cart that's been wiped (e.g. order commit).
    await db.delete(cartItems).where(eq(cartItems.cartId, firstId));
    await db.delete(carts).where(eq(carts.id, firstId));

    const { cartId: secondId, cart } = await addItem(firstId, PRODUCT_ID, 1);
    expect(secondId).not.toBe(firstId);
    expect(cart.lines).toHaveLength(1);
  });
});

describe('setQty / removeItem', () => {
  it('changes the quantity of a single line and recomputes the subtotal', async () => {
    const { cartId, cart } = await addItem(null, PRODUCT_ID, 1);
    const itemId = cart.lines[0]!.id;
    const updated = await setQty(cartId, itemId, 4);
    expect(updated.lines[0]?.quantity).toBe(4);
    expect(updated.subtotalGbp).toBe('96.00');
  });

  it('removes a line when quantity is set to 0', async () => {
    const { cartId, cart } = await addItem(null, PRODUCT_ID, 1);
    const itemId = cart.lines[0]!.id;
    const updated = await setQty(cartId, itemId, 0);
    expect(updated.lines).toHaveLength(0);
    expect(updated.subtotalGbp).toBe('0.00');
  });

  it('removeItem is equivalent to setQty(0)', async () => {
    const { cartId, cart } = await addItem(null, PRODUCT_ID, 2);
    const itemId = cart.lines[0]!.id;
    const updated = await removeItem(cartId, itemId);
    expect(updated.lines).toHaveLength(0);
  });

  it('throws ITEM_NOT_FOUND when the line belongs to another cart', async () => {
    const a = await addItem(null, PRODUCT_ID, 1);
    const b = await addItem(null, OTHER_PRODUCT_ID, 1);
    // Try to mutate B's line using A's cartId — must fail.
    const otherItemId = b.cart.lines[0]!.id;
    await expect(setQty(a.cartId, otherItemId, 5)).rejects.toMatchObject({
      code: 'ITEM_NOT_FOUND',
      status: 404,
    });
  });

  it('rejects invalid quantities', async () => {
    const { cartId, cart } = await addItem(null, PRODUCT_ID, 1);
    const itemId = cart.lines[0]!.id;
    await expect(setQty(cartId, itemId, -1)).rejects.toBeInstanceOf(CartError);
    await expect(setQty(cartId, itemId, 100)).rejects.toBeInstanceOf(CartError);
  });
});

describe('getOrCreateCart', () => {
  it('returns the empty view when cartId is null', async () => {
    const view = await getOrCreateCart(null);
    expect(view.cartId).toBeNull();
    expect(view.lines).toHaveLength(0);
    expect(view.subtotalGbp).toBe('0.00');
  });

  it('returns the empty view when cartId points at nothing', async () => {
    const view = await getOrCreateCart('00000000-0000-4000-8000-000000000000');
    expect(view.cartId).toBeNull();
    expect(view.lines).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Volume pricing
// ---------------------------------------------------------------------------

/**
 * £4.62 floor, £9.24 ceiling — the real figures for a filament spool once the
 * max is set to twice the min. One roll costs the ceiling, ten cost the floor,
 * and the steps between are (max-min)/9 = 51.33p, rounded once.
 */
describe('cart — volume pricing', () => {
  const FLOOR = '4.62';
  const CEILING = '9.24';

  beforeEach(() => {
    mockedPrice = FLOOR;
    mockedMaxPrice = CEILING;
  });

  it('charges the ceiling price for a single roll', async () => {
    const { cart } = await addItem(null, PRODUCT_ID, 1);
    expect(cart.lines[0]?.pricePerUnitGbp).toBe('9.24');
    expect(cart.subtotalGbp).toBe('9.24');
    expect(cart.unitsToBestPrice).toBe(9);
  });

  it('charges the floor price at ten rolls, exactly', async () => {
    const { cart } = await addItem(null, PRODUCT_ID, 10);
    expect(cart.lines[0]?.pricePerUnitGbp).toBe('4.62');
    expect(cart.subtotalGbp).toBe('46.20');
    expect(cart.unitsToBestPrice).toBe(0);
    // Nothing left to save, so no prompt.
    expect(cart.subtotalAtBestPriceGbp).toBeNull();
  });

  it('stays at the floor price beyond ten rolls', async () => {
    const { cart } = await addItem(null, PRODUCT_ID, 14);
    expect(cart.lines[0]?.pricePerUnitGbp).toBe('4.62');
    expect(cart.unitsToBestPrice).toBe(0);
  });

  it('re-prices rolls already in the basket when another is added', async () => {
    const first = await addItem(null, PRODUCT_ID, 1);
    expect(first.cart.lines[0]?.pricePerUnitGbp).toBe('9.24');

    const second = await addItem(first.cartId, PRODUCT_ID, 1);
    // Both rolls now cost less than the first one did on its own — this is
    // the requirement that made the price snapshot unworkable.
    expect(second.cart.lines[0]?.quantity).toBe(2);
    expect(Number(second.cart.lines[0]?.pricePerUnitGbp)).toBeLessThan(9.24);
    expect(Number(second.cart.subtotalGbp)).toBeLessThan(9.24 * 2);
  });

  it('puts the price back up when a roll is removed', async () => {
    const { cartId } = await addItem(null, PRODUCT_ID, 3);
    const three = await getOrCreateCart(cartId);
    const priceAtThree = Number(three.lines[0]?.pricePerUnitGbp);

    const line = three.lines[0]!;
    const afterRemoval = await setQty(cartId!, line.id, 2);
    expect(Number(afterRemoval.lines[0]?.pricePerUnitGbp)).toBeGreaterThan(priceAtThree);
  });

  it('counts different colours towards the same volume tier', async () => {
    // The discount is basket-wide, so five of each reaches the best price —
    // a customer mixing colours is not penalised for it.
    const first = await addItem(null, PRODUCT_ID, 5);
    const second = await addItem(first.cartId, OTHER_PRODUCT_ID, 5);
    expect(second.cart.itemCount).toBe(10);
    for (const line of second.cart.lines) {
      expect(line.pricePerUnitGbp).toBe('4.62');
    }
    expect(second.cart.subtotalGbp).toBe('46.20');
  });

  it('reports the saving still available while below the tier', async () => {
    const { cart } = await addItem(null, PRODUCT_ID, 2);
    expect(cart.unitsToBestPrice).toBe(8);
    // Two rolls at the floor price is what the prompt compares against.
    expect(cart.subtotalAtBestPriceGbp).toBe('9.24');
    expect(Number(cart.subtotalGbp)).toBeGreaterThan(9.24);
  });

  it('does not slide a product with no ceiling', async () => {
    mockedMaxPrice = null;
    const { cart } = await addItem(null, PRODUCT_ID, 1);
    expect(cart.lines[0]?.pricePerUnitGbp).toBe('4.62');
    const ten = await addItem(cart.cartId, PRODUCT_ID, 9);
    expect(ten.cart.lines[0]?.pricePerUnitGbp).toBe('4.62');
    // No saving to advertise when nothing slides.
    expect(ten.cart.subtotalAtBestPriceGbp).toBeNull();
  });

  it('exposes both ends of the band on each line', async () => {
    const { cart } = await addItem(null, PRODUCT_ID, 1);
    expect(cart.lines[0]?.unitPriceAtQtyOneGbp).toBe('9.24');
    expect(cart.lines[0]?.bestUnitPriceGbp).toBe('4.62');
  });
});
