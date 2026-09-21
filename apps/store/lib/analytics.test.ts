import { describe, expect, it } from 'vitest';
import {
  CONSENT_VERSION,
  GA_MEASUREMENT_ID,
  addToCartEventParams,
  analyticsCookieNames,
  beginCheckoutEventParams,
  unitPriceForQuantity,
  beginCheckoutToken,
  claimBeginCheckout,
  claimPurchase,
  cookieDomainsFor,
  gaEvent,
  gaPrice,
  gaVariant,
  hasAnalytics,
  isMeasurementId,
  parseConsent,
  purchaseEventParams,
  purchaseSentKey,
  resolveMeasurementId,
  serialiseConsent,
} from './analytics';

describe('measurement ID', () => {
  it('is configured with a valid GA4 Measurement ID', () => {
    expect(isMeasurementId(GA_MEASUREMENT_ID)).toBe(true);
  });

  it('rejects a property ID, which is what GA shows first and is easy to paste by mistake', () => {
    expect(isMeasurementId('484721657')).toBe(false);
    expect(resolveMeasurementId({}, '484721657')).toBeNull();
  });

  it('is switched off by STORE_ANALYTICS_DISABLED=true, and only by exactly that', () => {
    expect(resolveMeasurementId({ STORE_ANALYTICS_DISABLED: 'true' })).toBeNull();
    expect(resolveMeasurementId({ STORE_ANALYTICS_DISABLED: 'false' })).toBe(GA_MEASUREMENT_ID);
    expect(resolveMeasurementId({})).toBe(GA_MEASUREMENT_ID);
  });
});

describe('stored consent', () => {
  it('round-trips both choices', () => {
    expect(parseConsent(serialiseConsent('granted'))).toBe('granted');
    expect(parseConsent(serialiseConsent('denied'))).toBe('denied');
  });

  it('treats no choice, a garbled value, or an old version as not yet asked', () => {
    expect(parseConsent(null)).toBeNull();
    expect(parseConsent('yes')).toBeNull();
    expect(parseConsent(JSON.stringify({ v: CONSENT_VERSION + 1, analytics: 'granted' }))).toBeNull();
    expect(parseConsent(JSON.stringify({ v: CONSENT_VERSION, analytics: 'maybe' }))).toBeNull();
  });
});

describe('removing analytics cookies after a refusal', () => {
  it('finds the GA cookies and leaves the basket and other cookies alone', () => {
    expect(
      analyticsCookieNames('cart_id=abc; _ga=GA1.1.1; _ga_3RJWFM59VV=GS1.1; _gid=x; _gat_UA=1; other=2'),
    ).toEqual(['_ga', '_ga_3RJWFM59VV', '_gid', '_gat_UA']);
    expect(analyticsCookieNames('')).toEqual([]);
  });

  it('covers the host and each parent domain GA may have used', () => {
    expect(cookieDomainsFor('filament.cleverdeals.net')).toEqual([
      'filament.cleverdeals.net',
      '.filament.cleverdeals.net',
      '.cleverdeals.net',
    ]);
    expect(cookieDomainsFor('localhost')).toEqual(['localhost']);
    expect(cookieDomainsFor('127.0.0.1')).toEqual(['127.0.0.1']);
  });
});

describe('gaPrice / gaVariant', () => {
  it('reads money as a number, and rejects what is not money', () => {
    expect(gaPrice('6.14')).toBe(6.14);
    expect(gaPrice(9)).toBe(9);
    expect(gaPrice(null)).toBeUndefined();
    expect(gaPrice('')).toBeUndefined();
    expect(gaPrice('free')).toBeUndefined();
  });

  it('joins the parts that make a variant, ignoring the missing ones', () => {
    expect(gaVariant(['Bottle Green', 'XL'])).toBe('Bottle Green · XL');
    expect(gaVariant(['Bottle Green', null])).toBe('Bottle Green');
    expect(gaVariant([null, undefined, '  '])).toBeUndefined();
  });
});

describe('addToCartEventParams', () => {
  const item = { id: 'gr11bgxs', name: 'Eco Polo Shirt', priceGbp: '6.14', colour: 'Bottle Green', size: 'XS' };

  it('describes one item, with the line value', () => {
    expect(addToCartEventParams(item, 3)).toEqual({
      currency: 'GBP',
      value: 18.42,
      items: [
        {
          item_id: 'gr11bgxs',
          item_name: 'Eco Polo Shirt',
          price: 6.14,
          quantity: 3,
          item_variant: 'Bottle Green · XS',
          item_brand: undefined,
        },
      ],
    });
  });

  it('leaves the value out when there is no price, rather than sending zero', () => {
    const params = addToCartEventParams({ id: 'x', name: 'X' }, 1) as { value?: number };
    expect(params.value).toBeUndefined();
  });
});

describe('purchaseEventParams', () => {
  const order = {
    orderNumber: 'STORE-90AF3C522915',
    currencyCode: 'GBP',
    totals: { grandTotal: '13.14', taxTotal: '2.19', deliveryCharge: '7.00' },
    lines: [
      { productSlug: 'gr11bgxs', productName: 'Eco Polo Shirt', colour: 'Bottle Green', quantity: 1, pricePerUnit: '6.14' },
    ],
  };

  it('reports the order number, what was paid, and the lines', () => {
    expect(purchaseEventParams(order)).toEqual({
      transaction_id: 'STORE-90AF3C522915',
      value: 13.14,
      tax: 2.19,
      shipping: 7,
      currency: 'GBP',
      items: [
        {
          item_id: 'gr11bgxs',
          item_name: 'Eco Polo Shirt',
          price: 6.14,
          quantity: 1,
          item_variant: 'Bottle Green',
        },
      ],
    });
  });

  it('falls back to GBP when the order does not say', () => {
    const params = purchaseEventParams({ ...order, currencyCode: null }) as { currency: string };
    expect(params.currency).toBe('GBP');
  });
});

/**
 * These tests run in Node, where there is no `window`. The helpers all guard on
 * its absence, so a small stand-in is enough to exercise the browser paths.
 */
function withFakeWindow<T>(body: (win: Record<string, unknown>) => T): T {
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  const asStorage = (store: Map<string, string>) => ({
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  const win: Record<string, unknown> = {
    localStorage: asStorage(local),
    sessionStorage: asStorage(session),
  };
  (globalThis as { window?: unknown }).window = win;
  try {
    return body(win);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
}

describe('claimPurchase', () => {
  it('is true once per order, so a refresh is not a second sale', () => {
    withFakeWindow(() => {
      expect(claimPurchase('order-1')).toBe(true);
      expect(claimPurchase('order-1')).toBe(false);
      expect(claimPurchase('order-2')).toBe(true);
    });
  });

  it('names the key after the order', () => {
    expect(purchaseSentKey('order-1')).toBe('store_ga_purchase_order-1');
  });
});

describe('gaEvent', () => {
  it('does nothing without a browser at all', () => {
    expect(hasAnalytics()).toBe(false);
    expect(() => gaEvent('add_to_cart', { currency: 'GBP' })).not.toThrow();
  });

  it('does nothing when analytics is not running, so a refusal sends nothing', () => {
    withFakeWindow(() => {
      expect(hasAnalytics()).toBe(false);
      expect(() => gaEvent('add_to_cart', { currency: 'GBP' })).not.toThrow();
    });
  });

  it('sends the event once the tag is there', () => {
    withFakeWindow((win) => {
      const calls: unknown[][] = [];
      win.gtag = (...args: unknown[]) => calls.push(args);
      expect(hasAnalytics()).toBe(true);
      gaEvent('purchase', { transaction_id: 'X1' });
      expect(calls).toEqual([['event', 'purchase', { transaction_id: 'X1' }]]);
    });
  });
});

describe('beginCheckoutEventParams', () => {
  const cart = {
    cartId: 'cart-1',
    currencyCode: 'GBP',
    subtotalGbp: '31.20',
    lines: [
      {
        productId: 'p1',
        slug: 'classic-hoodie-navy',
        name: 'Classic hoodie · Navy · XL',
        colour: 'Navy',
        quantity: 2,
        pricePerUnitGbp: '12.60',
      },
      {
        productId: 'p2',
        slug: null,
        name: null,
        quantity: 1,
        pricePerUnitGbp: '6.00',
      },
    ],
  };

  it('reports the basket, falling back to the product id when there is no slug', () => {
    expect(beginCheckoutEventParams(cart)).toEqual({
      currency: 'GBP',
      value: 31.2,
      items: [
        {
          item_id: 'classic-hoodie-navy',
          item_name: 'Classic hoodie · Navy · XL',
          price: 12.6,
          quantity: 2,
          item_variant: 'Navy',
        },
        {
          item_id: 'p2',
          item_name: '',
          price: 6,
          quantity: 1,
          item_variant: undefined,
        },
      ],
    });
  });

  it('defaults the currency when the basket does not say', () => {
    expect(beginCheckoutEventParams({ ...cart, currencyCode: null }).currency).toBe('GBP');
  });
});

describe('beginCheckoutToken', () => {
  const base = {
    cartId: 'cart-1',
    subtotalGbp: '10.00',
    lines: [{ productId: 'p1', quantity: 1, pricePerUnitGbp: '10.00' }],
  };

  it('is stable for the same basket, so a reload does not count twice', () => {
    expect(beginCheckoutToken(base)).toBe(beginCheckoutToken({ ...base }));
  });

  it('changes when the basket changes, so a second attempt counts', () => {
    const changed = { ...base, subtotalGbp: '20.00', lines: [{ ...base.lines[0], quantity: 2 }] };
    expect(beginCheckoutToken(changed)).not.toBe(beginCheckoutToken(base));
  });
});

describe('claimBeginCheckout', () => {
  it('is true once per basket per session', () => {
    withFakeWindow(() => {
      expect(claimBeginCheckout('token-a')).toBe(true);
      expect(claimBeginCheckout('token-a')).toBe(false);
      expect(claimBeginCheckout('token-b')).toBe(true);
    });
  });
});

describe('unitPriceForQuantity', () => {
  const sliding = { id: 'p', name: 'Spool', priceGbp: '6.50', maxPriceGbp: '13.00' };

  it('charges the single-unit price for one, not the volume rate', () => {
    expect(unitPriceForQuantity(sliding, 1)).toBe(13);
  });

  it('charges the volume rate at ten', () => {
    expect(unitPriceForQuantity(sliding, 10)).toBe(6.5);
  });

  it('slides in between', () => {
    const five = unitPriceForQuantity(sliding, 5)!;
    expect(five).toBeLessThan(13);
    expect(five).toBeGreaterThan(6.5);
  });

  it('uses the only price a product that does not slide has', () => {
    expect(unitPriceForQuantity({ id: 'p', name: 'Tee', priceGbp: '12.00' }, 1)).toBe(12);
  });

  it('is undefined when there is no price at all', () => {
    expect(unitPriceForQuantity({ id: 'p', name: 'Tee' }, 1)).toBeUndefined();
  });
});

describe('addToCartEventParams with volume pricing', () => {
  it('reports what the customer will actually pay', () => {
    const params = addToCartEventParams(
      { id: 'spool-beige', name: 'Landau PLA Basic', priceGbp: '6.50', maxPriceGbp: '13.00' },
      1,
    ) as { value: number; items: Array<{ price: number }> };
    expect(params.value).toBe(13);
    expect(params.items[0]!.price).toBe(13);
  });
});
