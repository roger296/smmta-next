/**
 * Sample data for every template, for tests and previews. Product images and
 * names are made up; addresses are @example.com.
 */
import type { Block, ProductCard } from './blocks.js';
import type { TemplateData } from './registry.js';

const products: ProductCard[] = [
  { productId: '11111111-0000-4000-8000-000000000001', name: 'Landu PLA Basic', colour: 'Galaxy Black', imageUrl: 'https://images.example.com/pla-black.png', priceGbp: '17.99', tradePriceGbp: '14.50', groupSlug: 'landu-pla-basic', interestKeys: ['material:pla'] },
  { productId: '11111111-0000-4000-8000-000000000002', name: 'Landu PETG Pro', colour: 'Clear', imageUrl: 'https://images.example.com/petg-clear.png', priceGbp: '19.99', groupSlug: 'landu-petg-pro', interestKeys: ['material:petg'] },
];

const grid: Block = { type: 'ProductGrid', props: { title: 'New in PLA', products, cta: 'add' } };
const featured: Block = { type: 'FeaturedText', props: { heading: 'This week', markdown: 'PETG strings less **with a slower travel speed**. Our [guide](https://filament.cleverdeals.net/petg) has the numbers.' } };

export const SAMPLE_DATA: Record<string, TemplateData> = {
  back_in_stock: {
    items: [{ productId: products[0]!.productId, productName: 'Landu PLA Basic', productSlug: 'landu-pla-basic', productImageUrl: products[0]!.imageUrl, priceGbp: '17.99', colour: 'Galaxy Black' }],
  },
  weekly_digest: { blocks: [grid, featured, { type: 'DealsList', props: { deals: [{ title: '3 spools of PLA', description: 'mix any colours', priceGbp: '45.00', savingGbp: '8.97', url: 'https://filament.cleverdeals.net/pla' }] } }] },
  new_product_alert: { material: 'material:pla', blocks: [grid] },
  manual: { subject: 'Black Friday at CleverDeals', blocks: [{ type: 'Hero', props: { heading: 'Black Friday', body: 'Every PLA spool £14.99, this weekend only.', ctaUrl: 'https://filament.cleverdeals.net/pla', ctaLabel: 'Shop PLA' } }] },
  welcome_1: {},
  welcome_2: { material: 'material:petg', blocks: [grid] },
  welcome_3: { blocks: [{ type: 'Text', props: { body: 'Anything you would like us to stock? Reply and tell us.' } }] },
  abandoned_cart_1: { blocks: [{ type: 'CartContents', props: { lines: [{ productId: products[0]!.productId, name: 'Landu PLA Basic', colour: 'Galaxy Black', imageUrl: products[0]!.imageUrl, quantity: 2, priceGbp: '17.99' }] } }] },
  abandoned_cart_2: { blocks: [{ type: 'CartContents', props: { lines: [{ productId: products[1]!.productId, name: 'Landu PETG Pro', quantity: 1, priceGbp: '19.99' }], stockNote: 'Only 3 left in Clear.' } }] },
  abandoned_cart_3: { blocks: [{ type: 'CartContents', props: { lines: [{ productId: products[1]!.productId, name: 'Landu PETG Pro', quantity: 1, priceGbp: '19.99' }] } }] },
  replenishment_1: { material: 'material:pla', blocks: [{ type: 'ProductGrid', props: { products: [products[0]!], cta: 'add' } }] },
  replenishment_2: { material: 'material:pla', blocks: [{ type: 'ProductGrid', props: { products: [products[0]!], cta: 'add' } }] },
  post_purchase_tips: { material: 'material:petg', blocks: [{ type: 'FeaturedText', props: { markdown: 'Print PETG at 230–250 °C with a bed at 70–80 °C.' } }] },
  review_request: {},
  winback_1: { blocks: [grid] },
  winback_2: { blocks: [grid] },
  preorder_eta: { blocks: [{ type: 'Text', props: { body: 'Your pre-ordered PLA is now due around 21 November.' } }] },
  preorder_shipping: { blocks: [{ type: 'OrderSummary', props: { orderNumber: 'CD-1001', lines: [{ name: 'Landu PLA Basic — Galaxy Black', quantity: 2, lineTotalGbp: '35.98' }], totalGbp: '35.98' } }] },
  subscription_renewal: { blocks: [{ type: 'Text', props: { body: 'Your monthly box renews on 1 December.' } }] },
  subscription_add: { blocks: [grid] },
  price_drop: { blocks: [{ type: 'ProductGrid', props: { products: [products[1]!] } }] },
};
