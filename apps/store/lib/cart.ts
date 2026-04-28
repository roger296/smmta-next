/**
 * Cart service — server-only CRUD against the storefront DB's `carts` and
 * `cart_items` tables (Prompt 7 schema).
 *
 * Price snapshotting: when an item is added we read the live price from
 * `/storefront/products?ids=…` (Prompt 4) and write it into
 * `cart_items.price_snapshot_gbp`. All subsequent reads, total displays,
 * and checkouts use the snapshot; the cart is the customer's contract
 * until they re-add the line.
 *
 * Lazy cart creation: `getOrCreateCart(null)` returns an empty in-memory
 * shape. `addItem(null, ...)` inserts a new `carts` row and returns its
 * UUID so the route handler can write the cookie.
 */
import 'server-only';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from './db';
import { carts, cartItems } from '@/drizzle/schema';
import { getProductsByIds } from './smmta';

export interface CartLine {
  id: string;
  productId: string;
  quantity: number;
  pricePerUnitGbp: string;
  lineTotalGbp: string;
  /** Live data from SMMTA — name / slug / colour for display. May be null
   *  if the product has been unpublished since the line was added. */
  display: {
    name: string | null;
    slug: string | null;
    colour: string | null;
    heroImageUrl: string | null;
  };
}

export interface CartView {
  cartId: string | null;
  lines: CartLine[];
  subtotalGbp: string;
  itemCount: number;
  currencyCode: string;
}

export class CartError extends Error {
  readonly code:
    | 'CART_NOT_FOUND'
    | 'ITEM_NOT_FOUND'
    | 'INVALID_QUANTITY'
    | 'PRODUCT_NOT_FOUND';
  readonly status: number;
  constructor(
    message: string,
    code: CartError['code'],
    status: number,
  ) {
    super(message);
    this.name = 'CartError';
    this.code = code;
    this.status = status;
  }
}

const EMPTY_VIEW: CartView = {
  cartId: null,
  lines: [],
  subtotalGbp: '0.00',
  itemCount: 0,
  currencyCode: 'GBP',
};

// ---------------------------------------------------------------------------
// Money helpers — keep money in pence (integer) for arithmetic, format
// back to a 2-dp decimal string for output. The DB column is `decimal`
// so we read it as a string.
// ---------------------------------------------------------------------------

function toPence(amount: string): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) throw new Error(`Invalid money amount: ${amount}`);
  return Math.round(n * 100);
}

function fromPence(pence: number): string {
  return (pence / 100).toFixed(2);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getOrCreateCart(cartId: string | null): Promise<CartView> {
  if (!cartId) return EMPTY_VIEW;
  const db = getDb();
  const cart = await db.query.carts.findFirst({
    where: and(eq(carts.id, cartId), isNull(carts.deletedAt)),
  });
  if (!cart) return EMPTY_VIEW;

  const items = await db.query.cartItems.findMany({
    where: eq(cartItems.cartId, cart.id),
    orderBy: (i, { asc }) => [asc(i.addedAt)],
  });
  if (items.length === 0) {
    return {
      cartId: cart.id,
      lines: [],
      subtotalGbp: '0.00',
      itemCount: 0,
      currencyCode: cart.currencyCode,
    };
  }

  // Pull display data live for the lines that are present. Prices for
  // totals come from the snapshot, not from this read.
  const productIds = Array.from(new Set(items.map((i) => i.productId)));
  let displayMap = new Map<
    string,
    { name: string | null; slug: string | null; colour: string | null; heroImageUrl: string | null }
  >();
  try {
    const products = await getProductsByIds(productIds);
    displayMap = new Map(
      products.map((p) => [
        p.id,
        {
          name: p.name,
          slug: p.slug,
          colour: p.colour,
          heroImageUrl: p.heroImageUrl,
        },
      ]),
    );
  } catch {
    // If SMMTA is briefly unreachable we still want to render the cart with
    // the IDs and snapshots — display fields just degrade to empty.
  }

  let subtotalPence = 0;
  const lines: CartLine[] = items.map((it) => {
    const linePence = toPence(it.priceSnapshotGbp) * it.quantity;
    subtotalPence += linePence;
    return {
      id: it.id,
      productId: it.productId,
      quantity: it.quantity,
      pricePerUnitGbp: it.priceSnapshotGbp,
      lineTotalGbp: fromPence(linePence),
      display: displayMap.get(it.productId) ?? {
        name: null,
        slug: null,
        colour: null,
        heroImageUrl: null,
      },
    };
  });

  return {
    cartId: cart.id,
    lines,
    subtotalGbp: fromPence(subtotalPence),
    itemCount: lines.reduce((s, l) => s + l.quantity, 0),
    currencyCode: cart.currencyCode,
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Add a quantity of `productId` to the cart. Creates a cart if none exists.
 * If a line for the same productId already exists, increments its quantity
 * and **keeps the original price snapshot** — the snapshot is whatever was
 * captured at the first add.
 *
 * Returns the cart UUID so the route handler can persist the signed cookie.
 */
export async function addItem(
  cartId: string | null,
  productId: string,
  quantity: number,
): Promise<{ cartId: string; cart: CartView }> {
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 99) {
    throw new CartError(
      `Invalid quantity ${quantity} (1-99 allowed)`,
      'INVALID_QUANTITY',
      400,
    );
  }
  const db = getDb();

  // Resolve the live price for the price snapshot. If the product no
  // longer exists in the published catalogue, refuse the add — better
  // for the customer to see the error than to add a phantom line.
  const products = await getProductsByIds([productId]);
  const product = products.find((p) => p.id === productId);
  if (!product || !product.priceGbp) {
    throw new CartError(
      `Product ${productId} not available`,
      'PRODUCT_NOT_FOUND',
      404,
    );
  }
  const snapshot = product.priceGbp;

  // Resolve / create the cart.
  let resolvedCartId = cartId;
  if (!resolvedCartId) {
    const [created] = await db
      .insert(carts)
      .values({ currencyCode: 'GBP' })
      .returning({ id: carts.id });
    if (!created) throw new Error('Failed to create cart');
    resolvedCartId = created.id;
  } else {
    const cart = await db.query.carts.findFirst({
      where: and(eq(carts.id, resolvedCartId), isNull(carts.deletedAt)),
    });
    if (!cart) {
      // Cookie pointed at a deleted / unknown cart — start fresh.
      const [created] = await db
        .insert(carts)
        .values({ currencyCode: 'GBP' })
        .returning({ id: carts.id });
      if (!created) throw new Error('Failed to create cart');
      resolvedCartId = created.id;
    }
  }

  // Increment-or-insert.
  const existingLine = await db.query.cartItems.findFirst({
    where: and(eq(cartItems.cartId, resolvedCartId), eq(cartItems.productId, productId)),
  });
  if (existingLine) {
    await db
      .update(cartItems)
      .set({
        quantity: existingLine.quantity + quantity,
        updatedAt: new Date(),
      })
      .where(eq(cartItems.id, existingLine.id));
  } else {
    await db.insert(cartItems).values({
      cartId: resolvedCartId,
      productId,
      quantity,
      priceSnapshotGbp: snapshot,
    });
  }

  await refreshTotals(resolvedCartId);
  const view = await getOrCreateCart(resolvedCartId);
  return { cartId: resolvedCartId, cart: view };
}

/** Set a specific line's quantity. `quantity = 0` removes the line. */
export async function setQty(
  cartId: string,
  itemId: string,
  quantity: number,
): Promise<CartView> {
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 99) {
    throw new CartError(
      `Invalid quantity ${quantity} (0-99 allowed)`,
      'INVALID_QUANTITY',
      400,
    );
  }
  const db = getDb();
  const line = await db.query.cartItems.findFirst({
    where: and(eq(cartItems.id, itemId), eq(cartItems.cartId, cartId)),
  });
  if (!line) {
    throw new CartError(`Cart item ${itemId} not found`, 'ITEM_NOT_FOUND', 404);
  }
  if (quantity === 0) {
    await db.delete(cartItems).where(eq(cartItems.id, itemId));
  } else {
    await db
      .update(cartItems)
      .set({ quantity, updatedAt: new Date() })
      .where(eq(cartItems.id, itemId));
  }
  await refreshTotals(cartId);
  return getOrCreateCart(cartId);
}

/** Remove a line. */
export function removeItem(cartId: string, itemId: string): Promise<CartView> {
  return setQty(cartId, itemId, 0);
}

// ---------------------------------------------------------------------------
// Totals cache — kept in carts.totals_cache_gbp for fast cart-drawer reads.
// ---------------------------------------------------------------------------

async function refreshTotals(cartId: string): Promise<void> {
  const db = getDb();
  // Drizzle 0.41's `sum()` helper doesn't accept arithmetic between columns
  // (qty * price), so we pull the (qty, price) pairs and aggregate in JS.
  // Cart_items count is tiny by definition — this stays cheap.
  const items = await db
    .select({ qty: cartItems.quantity, price: cartItems.priceSnapshotGbp })
    .from(cartItems)
    .where(eq(cartItems.cartId, cartId));
  let pence = 0;
  for (const it of items) {
    pence += toPence(it.price) * it.qty;
  }
  await db
    .update(carts)
    .set({ totalsCacheGbp: fromPence(pence), updatedAt: new Date() })
    .where(eq(carts.id, cartId));
}
