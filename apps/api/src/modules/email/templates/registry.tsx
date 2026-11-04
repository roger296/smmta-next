/**
 * The template registry (runbook section 7 step 3). One entry per template
 * key: its class, how its subject is made, the "why you got this" line and
 * the blocks it shows when the send itself carries none. Automations
 * (section 12) only fill in content; every template exists from section 7.
 *
 * Subjects may use `{{first_name}}` with a fallback: `{{first_name|there}}`.
 */
import type { EmailClass } from '../../../db/schema/index.js';
import { materialName } from '../lib/interests.js';
import type { BackInStockEntry, Block } from './blocks.js';

export interface TemplateData {
  subject?: string;
  preheader?: string;
  blocks?: Block[];
  items?: BackInStockEntry[];
  material?: string;
  [k: string]: unknown;
}

export interface TemplateDef {
  key: string;
  class: EmailClass;
  /** Subject when the send / campaign gives none. */
  subject: (d: TemplateData) => string;
  preheader?: (d: TemplateData) => string;
  why: string;
  /** Blocks when the send / campaign gives none. */
  blocks?: (d: TemplateData) => Block[];
}

const MARKETING_WHY =
  'You are getting this because you asked to hear from CleverDeals. Use the links below to choose what we send, or to stop marketing emails.';
const SERVICE_WHY = 'You are getting this because of an order you placed with CleverDeals. It contains no offers.';

const mat = (d: TemplateData) => (d.material ? (materialName(d.material) ?? d.material) : 'filament');

function bisSubject(d: TemplateData): string {
  const items = d.items ?? [];
  if (items.length === 1) {
    const it = items[0]!;
    return `It's back: ${it.productName}${it.colour ? ` in ${it.colour}` : ''}`;
  }
  return `${items.length} things you asked about are back in stock`;
}

const text = (body: string): Block => ({ type: 'Text', props: { body } });

const defs: TemplateDef[] = [
  {
    key: 'back_in_stock',
    class: 'requested_service',
    subject: bisSubject,
    preheader: (d) => ((d.items ?? []).length === 1 ? `${d.items![0]!.productName} is back in stock.` : 'The things you asked about are back in stock.'),
    why: 'You are getting this because you asked us to tell you when this came back in stock. We send one email per request.',
    blocks: (d) => [{ type: 'BackInStockList', props: { title: (d.items ?? []).length > 1 ? "They're back in stock" : "It's back in stock", items: d.items ?? [] } }],
  },
  {
    key: 'weekly_digest',
    class: 'marketing',
    subject: () => "What's new at CleverDeals this week",
    why: 'You are getting our weekly email because you asked to hear from CleverDeals. We only send it when there is something new for you.',
  },
  {
    key: 'new_product_alert',
    class: 'marketing',
    subject: (d) => (d.material ? `New in ${mat(d)}` : 'New in at CleverDeals'),
    why: 'You are getting this new-product alert because you told us what you print with. You can switch these alerts off on the preferences page.',
  },
  { key: 'manual', class: 'marketing', subject: () => 'News from CleverDeals', why: MARKETING_WHY },
  {
    key: 'welcome_1',
    class: 'marketing',
    subject: () => 'Welcome to CleverDeals',
    why: MARKETING_WHY,
    blocks: () => [
      text('Thanks for signing up. We stock PLA, PETG, ABS, ASA and TPU from makers we trust, 1.75 mm on 1 kg spools, and we ship fast across the UK.'),
      text('Not sure which material suits a job? PLA is the easy all-rounder; PETG is tougher and copes with heat; ABS and ASA are for parts that live outdoors or near warmth; TPU is for anything that needs to flex.'),
    ],
  },
  { key: 'welcome_2', class: 'marketing', subject: (d) => `Our best-sellers in ${mat(d)}`, why: MARKETING_WHY },
  { key: 'welcome_3', class: 'marketing', subject: () => 'Ready for your first order?', why: MARKETING_WHY },
  {
    key: 'abandoned_cart_1',
    class: 'marketing',
    subject: () => 'You left something in your basket',
    why: MARKETING_WHY,
    blocks: () => [text('Your basket is saved. Pick up where you left off whenever you are ready.')],
  },
  { key: 'abandoned_cart_2', class: 'marketing', subject: () => 'Still thinking it over?', why: MARKETING_WHY },
  { key: 'abandoned_cart_3', class: 'marketing', subject: () => 'Your basket is waiting', why: MARKETING_WHY },
  {
    key: 'replenishment_1',
    class: 'marketing',
    subject: (d) => `Time to reorder your ${mat(d)}?`,
    why: MARKETING_WHY,
    blocks: (d) => [text(`By our reckoning your ${mat(d)} will be running low soon. One click puts the same spool back in your basket.`)],
  },
  { key: 'replenishment_2', class: 'marketing', subject: (d) => `Running low on ${mat(d)}?`, why: MARKETING_WHY },
  {
    key: 'post_purchase_tips',
    class: 'service',
    subject: (d) => `Getting the best from your ${mat(d)}`,
    why: SERVICE_WHY,
  },
  {
    key: 'review_request',
    class: 'service',
    subject: () => 'How was your order?',
    why: SERVICE_WHY,
    blocks: () => [text('We would be glad to hear how your filament printed. A short review helps other makers choose, and tells us what to stock next.')],
  },
  { key: 'winback_1', class: 'marketing', subject: () => 'New since you last visited', why: MARKETING_WHY },
  { key: 'winback_2', class: 'marketing', subject: () => "It's been a while", why: MARKETING_WHY },
  {
    key: 'preorder_eta',
    class: 'order_required',
    subject: () => 'An update on your pre-order',
    why: 'You are getting this because you placed a pre-order with CleverDeals.',
  },
  {
    key: 'preorder_shipping',
    class: 'order_required',
    subject: () => 'Your pre-order is on its way',
    why: 'You are getting this because you placed a pre-order with CleverDeals.',
  },
  {
    key: 'subscription_renewal',
    class: 'requested_service',
    subject: () => 'Your subscription renews soon',
    why: 'You are getting this because you have a subscription with CleverDeals.',
  },
  { key: 'subscription_add', class: 'marketing', subject: () => 'Anything to add to your next box?', why: MARKETING_WHY },
  { key: 'price_drop', class: 'marketing', subject: () => 'A price has dropped on something you like', why: MARKETING_WHY },
];

export const TEMPLATES: Record<string, TemplateDef> = Object.fromEntries(defs.map((d) => [d.key, d]));
export const TEMPLATE_KEYS = defs.map((d) => d.key);

export function getTemplate(key: string): TemplateDef {
  return TEMPLATES[key] ?? TEMPLATES.manual!;
}

/** `{{first_name}}` / `{{first_name|fallback}}` in a subject. */
export function fillSubject(subject: string, firstName: string | null): string {
  return subject.replace(/\{\{\s*first_name\s*(?:\|\s*([^}]*?))?\s*\}\}/g, (_m, fallback: string | undefined) =>
    firstName?.trim() ? firstName.trim() : (fallback ?? '').trim(),
  );
}
