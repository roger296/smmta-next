/**
 * Shipping / returns / product FAQ entries used both on the dedicated
 * `/faq` page and as the JSON-LD block on every group page.
 *
 * Pure data — kept in `lib/seo/` so the same array drives the visible
 * markup and the FAQPage JSON-LD without drifting.
 *
 * Keep the answers consistent with /legal/returns and /legal/terms (and
 * `lib/legal.ts`): the FAQ is a summary, the legal pages are the contract.
 */

export interface FaqEntry {
  question: string;
  answer: string;
}

export const SHIPPING_FAQ: FaqEntry[] = [
  {
    question: 'How long does delivery take?',
    answer:
      'Our supplier partners post every order from their UK warehouses. Order by 2pm (UK time) on a working day and it ships the same day; tracked delivery then normally takes 1–3 working days. Delivery is £7 per order, however many items you buy.',
  },
  {
    question: 'Do you ship outside the UK?',
    answer: 'Not at the moment — we deliver to UK addresses only.',
  },
  {
    question: 'Will my order arrive in one parcel?',
    answer:
      'Items from different suppliers are posted separately, so a larger order can arrive in more than one parcel. You pay one delivery charge for the whole order.',
  },
  {
    // Questions are rendered as text, so they use the character, not an entity.
    question: 'What’s your returns policy?',
    answer:
      'Unworn, unwashed items with their tags attached can be returned within 28 days of delivery for a full refund of the item price. Email sales@cleverdeals.net first for a returns reference and the address to send it to. Return postage is yours to pay unless the item is faulty or we sent the wrong thing. The full policy is on our returns page.',
  },
  {
    question: 'How do I know what size to order?',
    answer:
      'Each product page lists the sizes for that range, from the manufacturer&rsquo;s size guide. Sizes vary between brands, so check each range. If you&rsquo;re between sizes, size up.',
  },
  {
    question: 'Are the colours accurate?',
    answer:
      'We do our best to match the on-screen colour to the real garment — every product page swatch is the supplier&rsquo;s published colour. Screens vary, so there may be a small shift; if a colour matters (e.g. matching a uniform), order one piece first to check.',
  },
  {
    question: 'What if my item doesn’t fit?',
    answer:
      'Send it back unworn with its tags attached within 28 days for a full refund of the item price — email sales@cleverdeals.net first for a returns reference. Return postage is yours to pay unless the item is faulty or not as described.',
  },
  {
    question: 'Do you take uniform or team orders?',
    answer:
      'Yes — for larger orders of the same items, email sales@cleverdeals.net with what you need and we&rsquo;ll get back to you.',
  },
  {
    question: 'Can I change my order after placing it?',
    answer:
      'Orders go to our supplier partners within minutes of payment, so we usually can&rsquo;t change them. Email sales@cleverdeals.net with your order number straight away and we&rsquo;ll do what we can; otherwise you can return unwanted items under our returns policy.',
  },
];
