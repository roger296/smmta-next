import { describe, expect, it } from 'vitest';
import {
  escapeXml,
  feedClose,
  feedItemXml,
  feedOpen,
  feedSkipReason,
  feedStockItemXml,
  googleAgeGroup,
  googleGender,
  plainText,
  type FeedProduct,
} from './google-feed.js';

const product: FeedProduct = {
  id: 'GR11BGXS',
  title: 'Eco Polo Shirt · Bottle Green · XS',
  description: 'A 220gsm **recycled** polo shirt.',
  link: 'https://clothes.cleverdeals.net/shop/p/gr11bgxs',
  imageLink: 'https://images.uneekclothing.com/gr11-bottle-green.jpg',
  priceGbp: '6.14',
  availability: 'in_stock',
  brand: 'Uneek Clothing',
  gtin: '5056449221259',
  mpn: 'GR11',
  itemGroupId: 'gr11',
  colour: 'Bottle Green',
  size: 'XS',
  gender: 'unisex',
  ageGroup: 'adult',
  productTypePath: 'Tops > Polo shirts',
  shippingGbp: '8.50',
  shippingWeightKg: '0.310',
};

describe('feedSkipReason', () => {
  const base = {
    title: 'A shirt',
    link: 'https://shop/p/x',
    priceGbp: '6.14',
    imageLink: 'https://img/x.jpg',
  };

  it('passes a complete product', () => {
    expect(feedSkipReason(base)).toBeNull();
  });

  it('refuses the incomplete ones, most important first', () => {
    expect(feedSkipReason({ ...base, title: '  ' })).toBe('no_title');
    expect(feedSkipReason({ ...base, link: '' })).toBe('no_link');
    expect(feedSkipReason({ ...base, priceGbp: null })).toBe('no_price');
    expect(feedSkipReason({ ...base, priceGbp: '0.00' })).toBe('no_price');
    expect(feedSkipReason({ ...base, imageLink: null })).toBe('no_image');
  });

  it('refuses an image whose supplier licence has run out', () => {
    const now = new Date('2026-09-17T00:00:00Z');
    expect(
      feedSkipReason({ ...base, imageLicenceExpiresAt: new Date('2026-09-16T00:00:00Z'), now }),
    ).toBe('image_licence_expired');
    expect(
      feedSkipReason({ ...base, imageLicenceExpiresAt: new Date('2027-01-01T00:00:00Z'), now }),
    ).toBeNull();
  });
});

describe('plainText', () => {
  it('turns markdown into something readable', () => {
    expect(plainText('### Specifications\n\n50% **recycled** cotton')).toBe(
      'Specifications 50% recycled cotton',
    );
    expect(plainText('See [the guide](https://x/y) for sizes')).toBe('See the guide for sizes');
    expect(plainText(null)).toBe('');
  });

  it('truncates politely', () => {
    const long = 'x'.repeat(5_000);
    const out = plainText(long, 100);
    expect(out).toHaveLength(100);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('googleGender / googleAgeGroup', () => {
  it('maps supplier wording onto Google values', () => {
    expect(googleGender('Unisex')).toBe('unisex');
    expect(googleGender('Ladies')).toBe('female');
    expect(googleGender('Womens')).toBe('female');
    expect(googleGender('Mens')).toBe('male');
    expect(googleGender('')).toBeNull();
    expect(googleGender('Assorted')).toBeNull();

    expect(googleAgeGroup('Adult')).toBe('adult');
    expect(googleAgeGroup('Child')).toBe('kids');
    expect(googleAgeGroup('Baby')).toBe('infant');
    expect(googleAgeGroup('New Born')).toBe('newborn');
    expect(googleAgeGroup('Toddler')).toBe('toddler');
    expect(googleAgeGroup(null)).toBeNull();
  });
});

describe('feedItemXml', () => {
  it('writes the attributes Google needs', () => {
    const xml = feedItemXml(product);
    expect(xml).toContain('<g:id>GR11BGXS</g:id>');
    expect(xml).toContain('<g:price>6.14 GBP</g:price>');
    expect(xml).toContain('<g:availability>in_stock</g:availability>');
    expect(xml).toContain('<g:condition>new</g:condition>');
    expect(xml).toContain('<g:brand>Uneek Clothing</g:brand>');
    expect(xml).toContain('<g:gtin>5056449221259</g:gtin>');
    expect(xml).toContain('<g:item_group_id>gr11</g:item_group_id>');
    expect(xml).toContain('<g:size>XS</g:size>');
    expect(xml).toContain('<g:color>Bottle Green</g:color>');
    expect(xml).toContain('<g:product_type>Tops &gt; Polo shirts</g:product_type>');
    expect(xml).toContain('<g:price>8.50 GBP</g:price>');
    expect(xml).toContain('<g:shipping_weight>0.310 kg</g:shipping_weight>');
    // It has a barcode, so it must NOT claim the identifier is missing.
    expect(xml).not.toContain('identifier_exists');
  });

  it('declares a missing identifier when there is no barcode or part number', () => {
    const xml = feedItemXml({ ...product, gtin: null, mpn: null });
    expect(xml).toContain('<g:identifier_exists>no</g:identifier_exists>');
  });

  it('keeps brand+mpn as an identifier in its own right', () => {
    const xml = feedItemXml({ ...product, gtin: null });
    expect(xml).not.toContain('identifier_exists');
  });

  it('omits empty fields rather than writing empty tags', () => {
    const xml = feedItemXml({
      ...product,
      colour: null,
      size: null,
      gender: null,
      ageGroup: null,
      shippingGbp: null,
      shippingWeightKg: null,
    });
    expect(xml).not.toContain('<g:color>');
    expect(xml).not.toContain('<g:shipping>');
    expect(xml).not.toContain('<g:gender>');
  });

  it('escapes XML in titles and descriptions', () => {
    const xml = feedItemXml({ ...product, title: 'Jack & Jill "wide" <fit>' });
    expect(xml).toContain('Jack &amp; Jill &quot;wide&quot; &lt;fit&gt;');
  });

  it('falls back to the title when a product has no description', () => {
    const xml = feedItemXml({ ...product, description: null });
    expect(xml).toContain('<description>Eco Polo Shirt · Bottle Green · XS</description>');
  });

  it('drops duplicate and excess extra images', () => {
    const xml = feedItemXml({
      ...product,
      additionalImageLinks: [product.imageLink!, ...Array.from({ length: 12 }, (_, i) => `https://img/${i}.jpg`)],
    });
    const count = (xml.match(/additional_image_link/g) ?? []).length / 2;
    expect(count).toBe(10);
    expect(xml).not.toContain(`<g:additional_image_link>${product.imageLink}`);
  });
});

describe('feedStockItemXml', () => {
  it('carries only the id, price and availability', () => {
    const xml = feedStockItemXml(product);
    expect(xml).toContain('<g:id>GR11BGXS</g:id>');
    expect(xml).toContain('<g:price>6.14 GBP</g:price>');
    expect(xml).toContain('<g:availability>in_stock</g:availability>');
    // Everything else belongs to the nightly feed; repeating it here would
    // mean two places to get wrong.
    expect(xml).not.toContain('<title>');
    expect(xml).not.toContain('g:brand');
    expect(xml).not.toContain('g:shipping');
    expect(xml).not.toContain('g:image_link');
  });

  it('marks an out-of-stock item without needing the rest', () => {
    const xml = feedStockItemXml({ id: 'X1', priceGbp: '9.99', availability: 'out_of_stock' });
    expect(xml).toContain('<g:availability>out_of_stock</g:availability>');
  });

  it('writes nothing for an item with no id, since Google matches on it', () => {
    expect(feedStockItemXml({ ...product, id: '' })).toBe('');
  });
});

describe('feedOpen / feedClose', () => {
  it('wraps items in a valid RSS channel', () => {
    const xml =
      feedOpen({ title: 'Clothes Shop', link: 'https://clothes.cleverdeals.net', description: 'Clothing' }) +
      feedItemXml(product) +
      feedClose();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('xmlns:g="http://base.google.com/ns/1.0"');
    expect(xml.trimEnd().endsWith('</rss>')).toBe(true);
    expect((xml.match(/<item>/g) ?? []).length).toBe(1);
  });
});

describe('escapeXml', () => {
  it('escapes the five XML characters', () => {
    expect(escapeXml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &apos;');
  });
});
