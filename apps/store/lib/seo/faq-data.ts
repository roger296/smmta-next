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
      'Orders placed before 2pm ship same day from our UK warehouse. Standard tracked delivery arrives next working day in most of the UK; remote postcodes can take an extra day.',
  },
  {
    question: 'Do you ship outside the UK?',
    answer:
      'EU shipping is available at checkout. Duties and import VAT are payable on arrival per your country&rsquo;s rules.',
  },
  {
    question: 'What&rsquo;s your returns policy?',
    answer:
      'Spools still in their unbroken vacuum seal can be returned within 28 days of delivery for a full refund of the item price; you pay the return postage. We can&rsquo;t accept returns of opened or partially-used filament unless it&rsquo;s faulty — moisture absorption affects print quality and we don&rsquo;t resell anything we wouldn&rsquo;t print with ourselves. Faulty, damaged or incorrectly supplied items are always returnable and we pay the postage. Email sales@cleverdeals.net with your order number. See our full <a href="/legal/returns">returns policy</a> for your statutory cancellation rights.',
  },
  {
    question: 'What diameter do you stock?',
    answer:
      '1.75mm only — that&rsquo;s the standard for the vast majority of FDM 3D printers (Bambu, Prusa, Creality, Anycubic, Voron, etc.). 2.85mm / 3mm filament for older Ultimakers isn&rsquo;t something we currently carry.',
  },
  {
    question: 'How tight are the tolerances?',
    answer:
      'Every spool is manufactured to ±0.02mm diameter tolerance and tested before packing. Roundness and consistent diameter matter more than headline numbers — both are why our PETG and PLA print reliably even on speed-tuned printers.',
  },
  {
    question: 'How is the filament packaged?',
    answer:
      'Each spool is vacuum-sealed inside a recyclable cardboard box with a desiccant pack. The spool itself is cardboard (not plastic) on most ranges — recyclable, biodegradable, and fits the same printer mounts.',
  },
  {
    question: 'Which materials should I use?',
    answer:
      'PLA for prototyping, decorative prints, and anything that doesn&rsquo;t need heat resistance. PETG for functional prints, water-tight parts, and parts that need to flex without snapping. ABS / ASA for engineering applications and outdoor parts (ASA is UV-stable). TPU for flexible parts — phone cases, gaskets, grips.',
  },
  {
    question: 'Do you offer trade / volume discounts?',
    answer:
      'Yes — orders of 10+ spools of the same SKU get a discount applied at checkout. For larger volumes, email sales@cleverdeals.net and we&rsquo;ll quote.',
  },
  {
    question: 'Can I change my order after placing it?',
    answer:
      'If your order hasn&rsquo;t shipped, email sales@cleverdeals.net with your order number — we&rsquo;ll do our best to update it before it leaves the warehouse.',
  },
];
