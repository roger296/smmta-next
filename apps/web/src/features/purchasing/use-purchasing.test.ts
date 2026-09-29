/**
 * The order as the API sends it, read into what the screens show
 * (DECISIONS.md F24): the inherited screens read names the API never sent,
 * so totals, names and "received" all came out blank.
 */
import { describe, expect, it } from 'vitest';
import { normalisePurchaseOrder } from './use-purchasing';

describe('normalisePurchaseOrder', () => {
  const raw = {
    id: 'po-1',
    poNumber: 'PO-000123',
    supplierId: 's-1',
    supplier: { name: 'Brakes' },
    siteId: 'site-east',
    site: { name: 'London East' },
    lineTotal: '180.00',
    taxTotal: '0.00',
    grandTotal: '180.00',
    currencyCode: 'GBP',
    lines: [
      {
        id: 'l-1',
        productId: 'p-1',
        product: { name: 'Plain flour', purchaseUom: 'sack' },
        quantity: 10,
        qtyBookedIn: 4,
        qtyInvoiced: 0,
        taxRate: 0,
        pricePerUnit: '18.00',
        lineTotal: '180.00',
      },
    ],
  };

  it('reads the API names for totals, supplier and venue', () => {
    expect(normalisePurchaseOrder(raw)).toMatchObject({
      supplierName: 'Brakes',
      siteName: 'London East',
      subtotal: '180.00',
      taxAmount: '0.00',
      total: '180.00',
    });
  });

  it("reads each line's product name, unit and received quantity", () => {
    expect(normalisePurchaseOrder(raw).lines![0]).toMatchObject({
      productName: 'Plain flour',
      purchaseUom: 'sack',
      quantity: '10',
      quantityReceived: '4',
      quantityInvoiced: '0',
    });
  });

  it('an order raised before venues has none', () => {
    expect(normalisePurchaseOrder({ ...raw, siteId: null, site: null })).toMatchObject({ siteId: null, siteName: null });
  });
});
