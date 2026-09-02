/**
 * Seed content for the knowledge base.
 *
 * The FAQ document is transcribed from the storefront's own
 * `SHIPPING_FAQ` and legal pages, so the assistant's answers and the
 * published pages start out saying the same thing. It is a STARTING
 * POINT — once an operator saves an edit in admin, this is never
 * re-applied over it.
 *
 * Deliberately store-specific, unlike `default-prompts.ts`: a knowledge
 * base has to name the actual products, policies, and figures. The
 * clothing store gets its own seed (or an empty document the operator
 * fills), which is why this is keyed by document slug rather than
 * pretending to be domain-neutral.
 *
 * Keep the H2-per-question shape — the chunker splits on headings, and
 * one question per heading is what makes retrieval return a whole
 * answer rather than a fragment.
 */
import type { KbDocumentSlug } from '../../db/schema/index.js';

export interface KbSeedDocument {
  slug: KbDocumentSlug;
  title: string;
  markdown: string;
}

const FAQ_MARKDOWN = `## How long does delivery take?

Orders placed before 2pm ship the same day from our UK warehouse. Standard
tracked delivery arrives the next working day across most of the UK; remote
postcodes can take an extra day.

## Do you ship outside the UK?

EU shipping is available at checkout. Duties and import VAT are payable on
arrival according to the rules of the destination country.

## What is your returns policy?

Items still in their unbroken manufacturer seal can be returned within 28 days
of delivery for a full refund of the item price. The customer pays return
postage.

We cannot accept returns of opened or partially used stock unless it is faulty,
because we do not resell anything we would not use ourselves.

Faulty, damaged, or incorrectly supplied items are always returnable and we pay
the postage. Customers should email sales@cleverdeals.net with their order
number. Full policy, including statutory cancellation rights, is at
/legal/returns.

## Can I cancel an order after placing it?

If the order has not yet shipped, email sales@cleverdeals.net with the order
number and we will do our best to stop it before it leaves the warehouse. Once
dispatched it becomes a return.

Statutory cancellation rights under the Consumer Contracts Regulations apply in
addition to this and are set out at /legal/returns.

## How is an order packaged?

Each item is sealed and boxed for transit. Packaging is recyclable.

## Do you offer trade or volume discounts?

Yes. Orders of ten or more of the same item get a discount applied at checkout.
For larger volumes, customers should email sales@cleverdeals.net for a quote.

## Can I change the delivery address after ordering?

Only before dispatch. Email sales@cleverdeals.net with the order number as soon
as possible. Once the parcel is with the carrier we cannot redirect it.

## What payment methods do you accept?

Payment is taken through Mollie's secure hosted checkout. Card details never
reach our own servers.

## When will I be charged?

At checkout, when the order is placed. For pre-orders paid by bank transfer, the
payment is taken up front and is refundable in full any time before dispatch.

## My order has not arrived — what should I do?

Check the tracking link in the dispatch email first. If the tracking has not
updated for more than two working days, or the carrier says delivered and it has
not arrived, email sales@cleverdeals.net with the order number and we will chase
the carrier.

## Is VAT included in the prices shown?

Yes. All prices shown on the storefront include UK VAT at 20%. A VAT invoice is
available on request.
`;

const PRODUCT_ADVICE_MARKDOWN = `## About this document

This is the product-advice knowledge base. The assistant answers "how do I use
this" questions ONLY from what is written here.

Replace this placeholder with real guidance before enabling the product-advice
specialist. Use one H2 heading per question, phrased the way a customer would
ask it — the assistant retrieves by heading first.

## What should I do if I am not sure which product to choose?

Ask about the intended use rather than guessing. If the knowledge base does not
cover a comparison, say so and offer to pass the question to the team.
`;

export const KB_SEED_DOCUMENTS: KbSeedDocument[] = [
  {
    slug: 'faq',
    title: 'Delivery, returns & policy',
    markdown: FAQ_MARKDOWN,
  },
  {
    slug: 'product-advice',
    title: 'Product advice',
    markdown: PRODUCT_ADVICE_MARKDOWN,
  },
];
