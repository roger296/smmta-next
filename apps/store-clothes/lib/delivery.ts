/**
 * Customer-facing presentation of the per-parcel delivery charge.
 *
 * Each supplier sends its items in one parcel with its own delivery charge,
 * so a basket from two suppliers pays two charges. The checkout explains that
 * and points out that more items from the same supplier cost nothing extra.
 */
import type { DeliveryQuote } from './smmta';

export interface ParcelSummary {
  label: string;
  chargeGbp: string;
  itemNames: string[];
}

/** One entry per parcel, with the basket items it holds. */
export function summariseParcels(
  quote: DeliveryQuote,
  lines: Array<{ productId: string; name: string | null }>,
): ParcelSummary[] {
  return quote.parcels.map((parcel, i) => ({
    label:
      quote.parcels.length === 1
        ? 'Delivery'
        : `Delivery · parcel ${i + 1}${parcel.supplierName ? ` from ${parcel.supplierName}` : ''}`,
    chargeGbp: parcel.chargeGbp,
    itemNames: lines
      .filter((l) => parcel.productIds.includes(l.productId))
      .map((l) => l.name ?? 'Item'),
  }));
}

/** The note under the delivery charge. */
export function deliveryNote(parcelCount: number): string {
  if (parcelCount > 1) {
    return `Your items come from ${parcelCount} different suppliers, so they arrive in ${parcelCount} parcels with a delivery charge for each. You can add as many items as you like to a parcel at no extra delivery cost.`;
  }
  return 'One delivery charge, however many items you add.';
}
