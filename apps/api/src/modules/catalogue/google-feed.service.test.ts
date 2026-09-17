/**
 * Unit tests for the configuration helpers in `google-feed.service.ts`.
 * `buildGoogleFeed` itself reads the catalogue and is exercised by running it
 * against a database.
 */
import { describe, expect, it } from 'vitest';
import { feedPathFor, parseFeedShops } from './google-feed.service.js';

describe('parseFeedShops', () => {
  it('reads channel=origin pairs', () => {
    expect(
      parseFeedShops(
        'filament-store=https://filament.cleverdeals.net,clothes-shop=https://clothes.cleverdeals.net',
      ),
    ).toEqual([
      { channelSlug: 'filament-store', baseUrl: 'https://filament.cleverdeals.net' },
      { channelSlug: 'clothes-shop', baseUrl: 'https://clothes.cleverdeals.net' },
    ]);
  });

  it('tolerates spacing and trailing slashes', () => {
    expect(parseFeedShops('  clothes-shop = https://clothes.cleverdeals.net/  ')).toEqual([
      { channelSlug: 'clothes-shop', baseUrl: 'https://clothes.cleverdeals.net' },
    ]);
  });

  it('drops malformed entries instead of failing the whole run', () => {
    expect(
      parseFeedShops('clothes-shop=https://clothes.cleverdeals.net,broken,=https://x,shop=not-a-url'),
    ).toEqual([{ channelSlug: 'clothes-shop', baseUrl: 'https://clothes.cleverdeals.net' }]);
  });

  it('is empty when unset', () => {
    expect(parseFeedShops('')).toEqual([]);
    expect(parseFeedShops(null)).toEqual([]);
    expect(parseFeedShops(undefined)).toEqual([]);
  });
});

describe('feedPathFor', () => {
  it('names the file after the channel', () => {
    expect(feedPathFor('/app/uploads/feeds', 'clothes-shop').replace(/\\/g, '/')).toBe(
      '/app/uploads/feeds/clothes-shop.xml',
    );
  });
});

describe('feedPathFor (hourly feed)', () => {
  it('keeps the price-and-stock feed in its own file', () => {
    const slash = (p: string) => p.replace(/\\/g, '/');
    expect(slash(feedPathFor('/app/uploads/feeds', 'clothes-shop', 'stock'))).toBe(
      '/app/uploads/feeds/clothes-shop-stock.xml',
    );
    expect(slash(feedPathFor('/app/uploads/feeds', 'clothes-shop', 'full'))).toBe(
      '/app/uploads/feeds/clothes-shop.xml',
    );
  });
});
