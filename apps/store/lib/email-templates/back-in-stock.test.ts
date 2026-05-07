import { describe, expect, it } from 'vitest';
import { renderBackInStock } from './back-in-stock';

const base = {
  storeBaseUrl: 'https://filament.shop.example.com',
  productName: 'Landau PLA Pro 1.75mm 1kg',
  productSlug: 'landau-pla-pro-1-75mm-1kg',
  productImageUrl: 'https://example.com/img.png',
  priceGbp: '12.50',
  colour: 'Smoke',
};

describe('renderBackInStock', () => {
  it('builds a subject mentioning the product and colour', () => {
    const r = renderBackInStock(base);
    expect(r.subject).toBe("It's back: Landau PLA Pro 1.75mm 1kg in Smoke");
  });

  it('omits the colour from the subject when not given', () => {
    const r = renderBackInStock({ ...base, colour: null });
    expect(r.subject).toBe("It's back: Landau PLA Pro 1.75mm 1kg");
  });

  it('renders the price when supplied, omits cleanly when null', () => {
    const withPrice = renderBackInStock(base);
    expect(withPrice.html).toContain('£12.50');
    expect(withPrice.text).toContain('£12.50');

    const noPrice = renderBackInStock({ ...base, priceGbp: null });
    expect(noPrice.html).not.toContain('£');
    expect(noPrice.text).not.toContain('£');
  });

  it('renders an image when supplied, omits cleanly when null', () => {
    const withImg = renderBackInStock(base);
    expect(withImg.html).toContain('img src="https://example.com/img.png"');
    const noImg = renderBackInStock({ ...base, productImageUrl: null });
    expect(noImg.html).not.toContain('<img');
  });

  it('builds a deep link to the PDP with ?colour= when colour is set', () => {
    const r = renderBackInStock(base);
    expect(r.html).toContain(
      'href="https://filament.shop.example.com/shop/landau-pla-pro-1-75mm-1kg?colour=smoke"',
    );
  });

  it('falls back to /shop when slug is missing', () => {
    const r = renderBackInStock({ ...base, productSlug: null, colour: null });
    expect(r.html).toContain('href="https://filament.shop.example.com/shop"');
  });

  it('escapes HTML in product name and colour', () => {
    const r = renderBackInStock({
      ...base,
      productName: '<script>x</script>',
      colour: '"Red"',
    });
    expect(r.html).not.toContain('<script>x</script>');
    expect(r.html).toContain('&lt;script&gt;');
  });

  it('returns a non-empty plain-text body', () => {
    const r = renderBackInStock(base);
    expect(r.text).toContain("It's back");
    expect(r.text).toContain('Smoke');
    expect(r.text.length).toBeGreaterThan(50);
  });
});
