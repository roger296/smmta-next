/**
 * Loads what the shipped email and the track page add to an order: ranges
 * picked for the customer, and whether a VAT invoice can be downloaded.
 *
 * Never throws. Suggestions are a bonus: a catalogue or API hiccup leaves them
 * out rather than holding up the customer's email or order page.
 */
import 'server-only';
import type { PublicOrder } from './api-types';
import { log } from './log';
import { pickRecommendations, type Recommendation } from './recommendations';
import { getPublicOrder, listGroups } from './smmta';

export async function recommendationsForOrder(order: Pick<PublicOrder, 'lines'>): Promise<Recommendation[]> {
  try {
    return pickRecommendations(order, await listGroups());
  } catch (err) {
    log.warn({ err }, 'recommendations: catalogue unavailable, leaving suggestions out');
    return [];
  }
}

export async function shippedEmailExtras(
  orderId: string,
): Promise<{ recommendations: Recommendation[]; invoiceAvailable: boolean }> {
  let order: PublicOrder;
  try {
    order = await getPublicOrder(orderId);
  } catch (err) {
    log.warn({ err, orderId }, 'shipped email: order unavailable, sending without suggestions');
    return { recommendations: [], invoiceAvailable: false };
  }
  return { recommendations: await recommendationsForOrder(order), invoiceAvailable: Boolean(order.invoice) };
}
