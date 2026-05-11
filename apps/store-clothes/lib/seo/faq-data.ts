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
      'Orders placed before 2pm ship the next working day from our UK supplier partners. Standard tracked delivery arrives within 2–5 working days in most of the UK; remote postcodes can take an extra day or two.',
  },
  {
    question: 'Do you ship outside the UK?',
    answer:
      'EU shipping is available at checkout for most items. Duties and import VAT are payable on arrival per your country&rsquo;s rules.',
  },
  {
    question: 'What&rsquo;s your returns policy?',
    answer:
      'Unworn items can be returned within 30 days for a full refund — with original tags attached and in resaleable condition. We can&rsquo;t accept returns of worn or washed items, or anything that&rsquo;s had tags removed. Email orders@clothes.shop.cleverdeals.net for a prepaid label.',
  },
  {
    question: 'How do I know what size to order?',
    answer:
      'Each product page lists the size chart for that range. We stock real sizes — XS to 5XL on most adult ranges, and age bands on kids&rsquo; ranges. If you&rsquo;re between sizes, size up: it&rsquo;s easier to take in than to add fabric.',
  },
  {
    question: 'Are the colours accurate?',
    answer:
      'We do our best to match the on-screen colour to the real garment — every product page swatch is the supplier&rsquo;s published colour code. Monitors vary, so there may be a small shift; if a colour matters (e.g. matching a uniform), order one piece first to check.',
  },
  {
    question: 'How are items packaged?',
    answer:
      'Each item is packed in a recyclable poly mailer or cardboard box, depending on size. We don&rsquo;t use plastic hangers, individual tissue paper, or branded ribbon — just the garment, its tag, and a simple delivery note.',
  },
  {
    question: 'What if my item doesn&rsquo;t fit?',
    answer:
      'Send it back unworn with tags attached within 30 days for a full refund or exchange. If the fit is off because the garment doesn&rsquo;t match the size chart, we cover return postage; otherwise it&rsquo;s a £4.95 return label.',
  },
  {
    question: 'Do you offer trade / volume discounts?',
    answer:
      'Yes — orders of 10+ identical items get a discount applied at checkout. For uniform or team orders (logo embroidery, larger volumes), email orders@clothes.shop.cleverdeals.net and we&rsquo;ll quote.',
  },
  {
    question: 'Can I change my order after placing it?',
    answer:
      'If your order hasn&rsquo;t shipped, email orders@clothes.shop.cleverdeals.net with your order number — we&rsquo;ll do our best to update it before it leaves the warehouse.',
  },
];
