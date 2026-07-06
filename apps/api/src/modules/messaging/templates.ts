/**
 * Versioned compose-prompt templates (SPEC §12.3, F6/F7). Per-templateKey system
 * prompts embed the §16.2a honest cash-flow framing and the §15.1a £-not-%
 * rule. Percentages are FORBIDDEN in customer copy — enforced by a lint-style
 * test that scans these strings.
 */
export type MailCategory = 'transactional' | 'marketing';

export interface Template {
  key: string;
  category: MailCategory;
  /** Time-sensitive templates set an expiry (hours) so a stale draft never sends. */
  expiryHours?: number;
  systemPrompt: string;
}

const SHARED_RULES = `Write a short, warm, plain-English email. Rules you must follow:
- State savings and prices in pounds only (e.g. "save £4.00 a roll"). Never use
  a percentage figure in the copy.
- Never invent prices, discounts, ETAs, or promotions. Use only the facts given.
- Describe ETAs as estimates ("due around <date>").
Return ONLY a JSON object: {"subject": string, "body": string}.`;

export const TEMPLATES: Record<string, Template> = {
  eta_slip: {
    key: 'eta_slip',
    category: 'transactional',
    expiryHours: 72,
    systemPrompt: `A pre-order shipment the customer is waiting on has slipped. Offer three
options clearly: wait for the new estimated date, swap to in-stock at the same
pre-order price they locked, or a full refund. Reassure them their early payment
is protected and they can cancel any time before dispatch.
${SHARED_RULES}`,
  },
  back_in_stock: {
    key: 'back_in_stock',
    category: 'marketing',
    expiryHours: 168,
    systemPrompt: `A product the customer asked to be notified about is back in stock. Let them
know simply and invite them to buy while it lasts. Keep it brief.
${SHARED_RULES}`,
  },
  price_drop_offer: {
    key: 'price_drop_offer',
    category: 'marketing',
    expiryHours: 168,
    systemPrompt: `A product the customer is watching for offers now has a better price. Tell them
the new price and the pound saving. Do not pressure.
${SHARED_RULES}`,
  },
  run_out_reminder: {
    key: 'run_out_reminder',
    category: 'marketing',
    systemPrompt: `Based on their buying pattern the customer may be running low on a material.
Gently remind them and make reordering easy. It is a helpful nudge, not a hard
sell.
${SHARED_RULES}`,
  },
  lapsed_winback: {
    key: 'lapsed_winback',
    category: 'marketing',
    systemPrompt: `The customer hasn't bought in a while. Warmly check in and remind them what we
offer, with no pressure. A light "we've missed you" tone.
${SHARED_RULES}`,
  },
  subscription_upsell: {
    key: 'subscription_upsell',
    category: 'marketing',
    systemPrompt: `The customer buys regularly and could save with a subscription (bonus credit).
Explain the benefit in pounds using the facts given, and that they can skip or
pause any time. Never oversell.
${SHARED_RULES}`,
  },
  preorder_fulfilment: {
    key: 'preorder_fulfilment',
    category: 'transactional',
    systemPrompt: `A pre-order shipment has arrived and the customer's order is being prepared for
dispatch. Thank them for pre-ordering and confirm what happens next.
${SHARED_RULES}`,
  },
};

export function getTemplate(key: string): Template {
  const t = TEMPLATES[key];
  if (!t) throw new Error(`unknown template ${key}`);
  return t;
}
