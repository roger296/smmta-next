/**
 * /legal/terms — terms & conditions of sale and website use.
 *
 * Linked from the checkout consent tickbox, so it must always resolve.
 *
 * Adapted from the Filament Store terms (apps/store/app/legal/terms), which
 * were themselves adapted from the CleverDeals.net terms. Changes for the
 * Clothes Shop: clothing rather than filament, and items are posted by our
 * supplier partners, so an order can arrive in more than one parcel.
 *
 * As on the Filament Store, two parent-terms clauses are deliberately left
 * out because they are unlikely to bind a consumer under the Consumer Rights
 * Act 2015: the blanket liability exclusion and mandatory arbitration.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { LEGAL } from '@/lib/legal';
import { ContactEmail, LegalPage, LegalSection } from '../_components/legal-page';

export const revalidate = 86_400;

export const metadata: Metadata = {
  title: 'Terms & conditions',
  description:
    'The terms and conditions governing purchases from the Clothes Shop and use of this website — orders, pricing, delivery, liability and governing law.',
  alternates: { canonical: '/legal/terms' },
  robots: { index: true, follow: true },
};

export default function TermsPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Terms & conditions"
      intro={`These terms govern your use of ${LEGAL.siteUrl.replace('https://', '')} and any order you place with us. Please read them before buying.`}
    >
      <LegalSection id="about" heading="1. Who we are">
        <p>
          The {LEGAL.storeName} is a{' '}
          <a href={LEGAL.parentUrl} className="text-[var(--brand-ink)] underline" rel="noopener">
            {LEGAL.parentName}
          </a>{' '}
          store. {LEGAL.parentName} is a trading name of {LEGAL.legalEntity} — a company registered
          in England and Wales under company number {LEGAL.companyNumber}, whose registered office is
          at {LEGAL.registeredAddress}.
          {LEGAL.vatNumber ? ` Our VAT registration number is ${LEGAL.vatNumber}.` : ''} Your
          contract for any order is with {LEGAL.legalEntity}.
        </p>
        <p>
          We sell clothing, footwear, workwear and accessories to customers in the UK. Write to us at
          that address, or email <ContactEmail />.
        </p>
      </LegalSection>

      <LegalSection id="acceptance" heading="2. Acceptance of these terms">
        <p>
          By using this website or placing an order you agree to these terms, our{' '}
          <Link href="/legal/returns" className="text-[var(--brand-ink)] underline">
            returns policy
          </Link>{' '}
          and our{' '}
          <Link href="/legal/privacy" className="text-[var(--brand-ink)] underline">
            privacy policy
          </Link>
          , without modification. We may update these terms from time to time; the version in force
          is the one published on this page when you place your order.
        </p>
      </LegalSection>

      <LegalSection id="orders" heading="3. How a contract is formed">
        <p>
          Placing an order is an offer to buy. We will send an acknowledgement email confirming we
          have received it — this is not acceptance. A contract between us comes into existence only
          when your order is dispatched and we send you a dispatch confirmation.
        </p>
        <p>
          If we cannot fulfil an order — because an item has sold out, because it was mispriced, or
          because it cannot be delivered to your address — we will tell you and refund any payment
          for the items we cannot supply. We reserve the right to decline any order.
        </p>
      </LegalSection>

      <LegalSection id="pricing" heading="4. Prices and payment">
        <p>
          Prices are shown in pounds sterling, including VAT, on the product page and may change at
          any time, but changes do not affect orders we have already accepted. Delivery is charged
          in addition, per parcel, and is shown at checkout before you pay.
        </p>
        <p>
          Payment is taken at checkout through Mollie, our payment provider. Card details are entered
          on Mollie&rsquo;s secure hosted page and never reach our servers.
        </p>
        <p>
          We take reasonable care to price and describe every product accurately. Where an obvious
          pricing error occurs, we are not obliged to supply at the incorrect price; we will contact
          you to confirm whether you wish to proceed at the correct price or cancel.
        </p>
      </LegalSection>

      <LegalSection id="delivery" heading="5. Delivery">
        <p>
          Our items are packed and posted by our supplier partners from their UK warehouses. Orders
          placed before 2pm (UK time) on a working day are normally dispatched the same day. Delivery
          estimates are estimates, not guarantees, and we are not responsible for delays caused by the
          carrier or by events outside our reasonable control.
        </p>
        <p>
          Items from different suppliers are sent separately, so an order may arrive in more than one
          parcel. Each parcel has one delivery charge, however many items it holds, and the charges
          for your order are shown at checkout before you pay.
        </p>
        <p>
          Risk in the goods passes to you on delivery. Ownership passes when we have received payment
          in full.
        </p>
      </LegalSection>

      <LegalSection id="returns" heading="6. Cancellation and returns">
        <p>
          Your cancellation and returns rights — including your statutory{' '}
          {LEGAL.statutoryCancellationDays}-day right to cancel a distance purchase and our longer{' '}
          {LEGAL.returnsWindowDays}-day returns policy for unworn items — are set out in full in our{' '}
          <Link href="/legal/returns" className="text-[var(--brand-ink)] underline">
            returns policy
          </Link>
          , which forms part of these terms.
        </p>
      </LegalSection>

      <LegalSection id="product-info" heading="7. Product information, sizing and suitability">
        <p>
          Product descriptions, size guides and specifications come from the manufacturers. Sizes vary
          between brands, so please check the size guide for each item. Colours can look different on
          screen from how they look in person.
        </p>
        <p>
          Workwear, high-visibility clothing and safety footwear meet the standards their
          manufacturers state for them. It is your responsibility, or your employer&rsquo;s, to decide
          whether an item is suitable protection for a particular job or workplace; we do not carry out
          risk assessments.
        </p>
      </LegalSection>

      <LegalSection id="ip" heading="8. Intellectual property">
        <p>
          The intellectual property rights in all software, text, imagery and other content on this
          website remain the property of {LEGAL.legalEntity}, its licensors, partners or content
          suppliers. You may not reproduce or republish it without our permission.
        </p>
        <p>
          Any third-party trademarks or brand names shown on this site are owned by their respective
          owners. We claim no connection, association or affiliation with them unless specifically
          stated.
        </p>
      </LegalSection>

      <LegalSection id="ugc" heading="9. Material you submit to us">
        <p>
          Any information or material you submit to us or publish in a public area of this site is
          provided on a non-confidential basis. You grant us a perpetual, royalty-free,
          non-exclusive licence to use, edit, copy, republish and distribute it, and to authorise
          others to do the same. You must not submit anything unlawful, defamatory, or infringing
          someone else&rsquo;s rights.
        </p>
      </LegalSection>

      <LegalSection id="site" heading="10. Website availability">
        <p>
          We aim to keep this site available at all times but do not guarantee uninterrupted access.
          We may suspend, withdraw or change all or part of it without notice, and we will not be
          liable if it is unavailable for any period.
        </p>
      </LegalSection>

      <LegalSection id="liability" heading="11. Our liability">
        <p>
          Nothing in these terms excludes or limits our liability for death or personal injury caused
          by our negligence, for fraud or fraudulent misrepresentation, for breach of the terms
          implied by the Consumer Rights Act 2015, or for any other liability that cannot lawfully be
          excluded or limited.
        </p>
        <p>
          Subject to that, we are not liable for losses that were not foreseeable at the time the
          contract was formed, or for loss of profit or business loss where you buy for business use.
          Where we are liable, our total liability in connection with an order will not exceed the
          price you paid for that order.
        </p>
      </LegalSection>

      <LegalSection id="events" heading="12. Events outside our control">
        <p>
          We are not liable for any failure or delay in performing our obligations where that failure
          or delay results from events outside our reasonable control, including carrier failure,
          supplier failure, industrial action, fire, flood, or interruption of power or
          telecommunications.
        </p>
      </LegalSection>

      <LegalSection id="severability" heading="13. Severability">
        <p>
          If any part of these terms is found to be unenforceable, the enforceability of the
          remaining terms is not affected. So far as possible, where a clause can be severed to
          leave the remainder valid, it will be interpreted accordingly.
        </p>
      </LegalSection>

      <LegalSection id="law" heading="14. Governing law and disputes">
        <p>
          These terms are governed by the laws of England and Wales. If you are a consumer, you may
          bring proceedings in the courts of England and Wales or, if you live in Scotland or
          Northern Ireland, in the courts of the country in which you live.
        </p>
        <p>
          If something goes wrong, please contact us first at <ContactEmail /> — most problems are
          resolved quickly and informally.
        </p>
      </LegalSection>

      <LegalSection id="entire" heading="15. Entire agreement">
        <p>
          These terms, together with our returns policy and privacy policy, constitute the entire
          agreement between us in relation to your order and supersede any previous arrangement. Any
          waiver of a provision will be effective only if given in writing by us.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
