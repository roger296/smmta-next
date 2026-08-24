/**
 * /legal/terms — terms & conditions of sale and website use.
 *
 * Linked from the checkout consent tickbox, so it must always resolve.
 *
 * Adapted from the CleverDeals.net terms, with the group-buying machinery
 * (deals, commitments, minimum group sizes, card authorisations) removed —
 * Filament Store is a straightforward direct-purchase retailer, so the contract
 * forms on dispatch rather than on a deal closing.
 *
 * Two clauses in the parent terms were deliberately NOT carried over because
 * they are unlikely to bind a consumer under the Consumer Rights Act 2015:
 *   - the blanket "not liable for any damages whatsoever" exclusion, replaced
 *     here with a limitation that carves out the liabilities that cannot
 *     lawfully be excluded; and
 *   - the mandatory-arbitration / waiver-of-court-access clause, replaced with
 *     the statutory position (English courts; consumers may also sue locally).
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { LEGAL } from '@/lib/legal';
import { LegalPage, LegalSection } from '../_components/legal-page';

export const revalidate = 86_400;

export const metadata: Metadata = {
  title: 'Terms & conditions',
  description:
    'The terms and conditions governing purchases from Filament Store and use of this website — orders, pricing, delivery, liability and governing law.',
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
          {LEGAL.storeName} is a sub-brand of{' '}
          <a href={LEGAL.parentUrl} className="text-[var(--brand-ink)] underline" rel="noopener">
            {LEGAL.parentName}
          </a>
          , a trading name of {LEGAL.legalEntity} — a company registered in England and Wales under
          company number {LEGAL.companyNumber}, whose registered office is at{' '}
          {LEGAL.registeredAddress}.
          {LEGAL.vatNumber ? ` Our VAT registration number is ${LEGAL.vatNumber}.` : ''} Your
          contract for any order is with {LEGAL.legalEntity}.
        </p>
        <p>
          We sell 3D printer filament direct to customers in the UK and EU. Write to us at that
          address, or email{' '}
          <a href={`mailto:${LEGAL.ordersEmail}`} className="text-[var(--brand-ink)] underline">
            {LEGAL.ordersEmail}
          </a>
          .
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
          when we dispatch the goods and send you a dispatch confirmation.
        </p>
        <p>
          If we cannot fulfil an order — because an item is out of stock, because it was mispriced,
          or because we cannot deliver to your address — we will tell you and refund any payment in
          full. We reserve the right to decline any order.
        </p>
      </LegalSection>

      <LegalSection id="pricing" heading="4. Prices and payment">
        <p>
          Prices are shown in pounds sterling on the product page and may change at any time, but
          changes do not affect orders we have already accepted. Delivery is charged in addition and
          is shown at checkout before you pay.
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
          Orders placed before 2pm on a working day are normally dispatched the same day from our UK
          warehouse. Delivery estimates are estimates, not guarantees, and we are not responsible for
          delays caused by the carrier or by events outside our reasonable control.
        </p>
        <p>
          Risk in the goods passes to you on delivery. Ownership passes when we have received payment
          in full.
        </p>
        <p>
          For deliveries outside the UK, any import duties or taxes are payable by you on arrival
          under the rules of the destination country.
        </p>
      </LegalSection>

      <LegalSection id="returns" heading="6. Cancellation and returns">
        <p>
          Your cancellation and returns rights — including your statutory{' '}
          {LEGAL.statutoryCancellationDays}-day right to cancel a distance purchase and our longer{' '}
          {LEGAL.returnsWindowDays}-day goodwill policy for sealed spools — are set out in full in
          our{' '}
          <Link href="/legal/returns" className="text-[var(--brand-ink)] underline">
            returns policy
          </Link>
          , which forms part of these terms.
        </p>
      </LegalSection>

      <LegalSection id="product-use" heading="7. Product information and suitability">
        <p>
          Print temperatures, tolerances and other specifications are published as guidance. Optimal
          settings vary between printers, nozzles, ambient conditions and models, and it is your
          responsibility to satisfy yourself that a material is suitable for your intended
          application before relying on it.
        </p>
        <p>
          Our filament is sold for use in FDM 3D printing. It is not certified for food contact,
          medical, aerospace, structural or other safety-critical applications unless we state so
          expressly in writing.
        </p>
      </LegalSection>

      <LegalSection id="ip" heading="8. Intellectual property">
        <p>
          The intellectual property rights in all software, text, imagery and other content on this
          website remain the property of {LEGAL.legalEntity}, its licensors, partners or content
          suppliers. You may not reproduce or republish it without our permission.
        </p>
        <p>
          Any third-party trademarks or product names shown on this site are owned by their
          respective owners. We claim no connection, association or affiliation with them unless
          specifically stated.
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
          contract was formed, or for loss of profit, loss of production, wasted print time, wasted
          material, or loss arising from your use of the goods in a commercial context. Where we are
          liable, our total liability in connection with an order will not exceed the price you paid
          for that order.
        </p>
        <p>
          If defective goods we supplied damage your property, we will repair the damage or pay you
          compensation — but we will not be liable where the damage results from your failure to
          follow reasonable instructions or from use in a safety-critical application.
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
          If something goes wrong, please contact us first at{' '}
          <a href={`mailto:${LEGAL.ordersEmail}`} className="text-[var(--brand-ink)] underline">
            {LEGAL.ordersEmail}
          </a>{' '}
          — most problems are resolved quickly and informally.
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
