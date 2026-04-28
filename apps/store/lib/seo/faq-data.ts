/**
 * Shipping / returns / product FAQ entries used both on the dedicated
 * `/faq` page and as the JSON-LD block on every group page.
 *
 * Pure data — kept in `lib/seo/` so the same array drives the visible
 * markup and the FAQPage JSON-LD without drifting.
 */

export interface FaqEntry {
  question: string;
  answer: string;
}

export const SHIPPING_FAQ: FaqEntry[] = [
  {
    question: 'How long does delivery take?',
    answer:
      'Orders ship from our UK workshop within 1–2 working days. Standard tracked delivery arrives next-day in most of the UK; remote postcodes can take an extra day.',
  },
  {
    question: 'Do you ship outside the UK?',
    answer:
      'EU shipping is available at checkout. Duties and import VAT are payable on arrival per your country&rsquo;s rules.',
  },
  {
    question: 'What&rsquo;s your returns policy?',
    answer:
      'Unused lamps can be returned within 30 days for a full refund. Email orders@filament.shop and we&rsquo;ll send you a prepaid label.',
  },
  {
    question: 'Are the lamps dimmable?',
    answer:
      'Yes — every lamp in the range is dimmable on any standard trailing-edge dimmer. Old leading-edge dimmers may need replacing for flicker-free operation.',
  },
  {
    question: 'Do the lamps come with a warranty?',
    answer:
      'Every lamp carries a 2-year warranty against manufacturing defects. The LED module itself is rated for 25,000 hours.',
  },
  {
    question: 'Can I change my order after placing it?',
    answer:
      'If your order hasn&rsquo;t shipped, email orders@filament.shop with your order number — we&rsquo;ll do our best to update it before it leaves the workshop.',
  },
];
