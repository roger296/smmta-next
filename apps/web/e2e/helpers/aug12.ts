/**
 * The 12 August 2026 South London session, as fixtures (F15).
 *
 * The same delivery, the same two products, the same venue — so the regression
 * matrix and the full-journey spec are a like-for-like replay of the session
 * that produced the defect register, not a fresh invention.
 */
import type { Page } from '@playwright/test';
import { TEST_VENUE } from './touch';

export interface Aug12Product {
  id: string;
  name: string;
  stockCode: string;
  barcode: string;
  stockUom: string;
  purchaseUom: string | null;
  packDescription: string | null;
  purchaseToStockFactor: string;
  expectedNextCost: string;
  countQuantum?: string | null;
  requireBatchNumber: boolean;
}

/** 25 kg sack, £30 a sack — £0.0012 a gram, the figure that rendered as £0.00. */
export const ICING: Aug12Product = {
  id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  name: 'Icing sugar',
  stockCode: 'ING-ICING',
  barcode: '5012345678900',
  stockUom: 'g',
  purchaseUom: 'sack',
  packDescription: '25 kg sack',
  purchaseToStockFactor: '25000',
  expectedNextCost: '30.000000',
  countQuantum: null,
  requireBatchNumber: false,
};

/** 1.6 kg bags — "preventing the 1.6kg bags from being added". */
export const SKITTLES: Aug12Product = {
  ...ICING,
  id: '1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  name: 'Skittles',
  stockCode: 'ING-SKITTLE',
  barcode: '4009900484220',
  purchaseUom: 'bag',
  packDescription: '1.6 kg bag',
  purchaseToStockFactor: '1600',
  expectedNextCost: '4.500000',
};

export const AUG12_PRODUCTS = [ICING, SKITTLES];

export const RECEIPT = {
  receipt: {
    id: 'receipt-aug12',
    siteId: TEST_VENUE.id,
    reference: null,
    totalStockValue: '138.00',
    receivedAt: '2026-08-19T10:00:00.000Z',
  },
  lines: [],
  alreadyExisted: false,
};

/** The count sheet, carrying product identity with it (D-1b). */
export const STOCK_TAKE = {
  take: { id: 'take-aug12' },
  lines: AUG12_PRODUCTS.map((p) => ({
    productId: p.id,
    bookQty: '4000',
    productName: p.name,
    stockCode: p.stockCode,
    stockUom: p.stockUom,
    itemKind: 'INGREDIENT',
    countQuantum: null,
  })),
};

/** One BASE + GF variant recipe, as the importer would have written it. */
export const RECIPE_LINES = [
  {
    productId: ICING.id,
    productName: 'Icing sugar',
    stockUom: 'g',
    expectedQty: 2000,
    qtyPerCover: 400,
    unitCost: 0.0012,
    expectedCost: 2.4,
  },
];

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

/**
 * Every read a venue screen makes, answered from the fixtures above.
 *
 * `/products/by-code/:code` is registered AFTER `/products**`, because
 * Playwright's last-registered handler wins and the generic route also matches
 * the exact one — which is how a nameless line got added to a goods-in sheet.
 */
export async function stubAug12(page: Page, opts: { products?: Aug12Product[] } = {}) {
  const products = opts.products ?? AUG12_PRODUCTS;

  await page.route('**/api/v1/sites**', (route) =>
    route.fulfill(json({ success: true, data: [{ ...TEST_VENUE, isActive: true }] })),
  );
  await page.route('**/api/v1/products?**', (route) => {
    // Honour `search`. A stub that returns the whole catalogue for every query
    // makes the exact-lookup miss path untestable: `resolveBarcodeToProduct`
    // falls back to search, and an unfiltered list always "finds" something.
    const search = (new URL(route.request().url()).searchParams.get('search') ?? '').toLowerCase();
    const data = search
      ? products.filter((p) =>
          [p.name, p.stockCode, p.barcode].some((f) => f.toLowerCase().includes(search)),
        )
      : products;
    return route.fulfill(
      json({ success: true, data, total: data.length, page: 1, pageSize: 50, totalPages: 1 }),
    );
  });
  await page.route('**/api/v1/products/by-code/**', (route) => {
    const code = decodeURIComponent(route.request().url().split('/by-code/')[1] ?? '');
    const match = products.find((p) => p.barcode === code || p.stockCode === code);
    return route.fulfill(
      match
        ? json({ success: true, data: match })
        : json({ success: false, error: 'No product carries that code' }, 404),
    );
  });
  await page.route('**/api/v1/stock-takes', (route) =>
    route.fulfill(json({ success: true, data: STOCK_TAKE }, 201)),
  );
  await page.route('**/api/v1/stock-takes/*/counts', (route) =>
    route.fulfill(json({ success: true, data: { recorded: 1 } })),
  );
  await page.route('**/api/v1/stock-takes/*/approve', (route) =>
    route.fulfill(json({ success: true, data: { take: { id: STOCK_TAKE.take.id, status: 'APPROVED' } }, warnings: [] })),
  );
  await page.route('**/api/v1/recipes/bakes', (route) =>
    route.fulfill(json({ success: true, data: ['Battenburg'] })),
  );
  await page.route('**/api/v1/recipes/coverage**', (route) =>
    route.fulfill(json({ success: true, data: { hasRecipe: true, glutenFree: true, vegan: true } })),
  );
  await page.route('**/api/v1/recipes/expected', (route) =>
    route.fulfill(json({ success: true, data: { lines: RECIPE_LINES, blockers: [] } })),
  );
  await page.route('**/api/v1/goods-in', (route) => route.fulfill(json({ success: true, data: RECEIPT }, 201)));
  await page.route('**/api/v1/goods-in/*/reverse', (route) =>
    route.fulfill(json({ success: true, data: { reversal: { id: 'rev-aug12' }, alreadyExisted: false } }, 201)),
  );
  await page.route('**/api/v1/session-consumption', (route) =>
    route.fulfill(json({ success: true, data: { id: 'consumption-aug12' } }, 201)),
  );
}

/** Add one product to the goods-in sheet by typing its barcode. */
export async function addByCode(page: Page, code: string) {
  await page.getByLabel(/product code/i).fill(code);
  await page.getByRole('button', { name: /\+ add/i }).click();
}
