/**
 * /legal/privacy — privacy policy (UK GDPR / Data Protection Act 2018).
 *
 * Adapted from the CleverDeals.net privacy policy. Changes from the parent:
 *   - group-buying references ("commit to a deal", membership) removed;
 *   - lawful bases stated explicitly per purpose — the parent policy describes
 *     what it does with data but never names a lawful basis, which UK GDPR
 *     Art.13(1)(c) requires in the privacy notice;
 *   - the data-subject rights section enumerates all rights rather than only
 *     access/rectification/objection;
 *   - adds the right to complain to the ICO, which a UK notice must include;
 *   - "EEA" transfer wording updated for the post-Brexit UK position.
 *
 * The AI search/assistant paragraph matches the platform's actual behaviour:
 * only the customer's typed query goes to the model provider, and the
 * llm_search_log table has no IP / email / session columns by design.
 */
import type { Metadata } from 'next';
import { LEGAL } from '@/lib/legal';
import { LegalPage, LegalSection } from '../_components/legal-page';

export const revalidate = 86_400;

export const metadata: Metadata = {
  title: 'Privacy policy',
  description:
    'How Filament Store collects, stores and uses your personal information, the lawful bases we rely on, how long we keep it, and your rights under UK GDPR.',
  alternates: { canonical: '/legal/privacy' },
  robots: { index: true, follow: true },
};

export default function PrivacyPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Privacy policy"
      intro="We collect as little as we can, use it only for what we told you, and keep it no longer than we need to. This page explains exactly what that means."
    >
      <LegalSection id="who" heading="1. Who we are">
        <p>
          {LEGAL.storeName} is a sub-brand of {LEGAL.parentName}, a trading name of{' '}
          {LEGAL.legalEntity} (company number {LEGAL.companyNumber}), registered at{' '}
          {LEGAL.registeredAddress}. {LEGAL.legalEntity} is the data controller for the personal
          information described in this policy.
        </p>
        <p>
          Questions, requests or complaints about privacy should go to{' '}
          <a href={`mailto:${LEGAL.contactEmail}`} className="text-[var(--brand-ink)] underline">
            {LEGAL.contactEmail}
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection id="principles" heading="2. Our approach">
        <p>
          We comply with the UK GDPR and the Data Protection Act 2018. Personal information we hold
          about you will be used lawfully, fairly and transparently. It is collected only for valid
          purposes we have explained to you, and not used in any way incompatible with those
          purposes. We keep it accurate and up to date, hold it only as long as necessary, and store
          it securely.
        </p>
        <p>
          &ldquo;Personal data&rdquo; means information about an individual from whom that person
          can be identified. It does not include data where the identity has been removed.
        </p>
      </LegalSection>

      <LegalSection id="what" heading="3. What we collect">
        <p>Information you give us:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-[var(--brand-ink)]">Order details</strong> — name, delivery and
            billing address, email address and phone number.
          </li>
          <li>
            <strong className="text-[var(--brand-ink)]">Contact and support</strong> — anything you
            include when you email us or use the on-site assistant.
          </li>
          <li>
            <strong className="text-[var(--brand-ink)]">Marketing preferences</strong> — if you join
            our mailing list or ask to be told when an item is back in stock.
          </li>
        </ul>
        <p>Information we collect automatically:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Technical information, including the IP address used to connect to our site, browser
            type, and pages viewed.
          </li>
          <li>Your basket contents, so it survives between visits.</li>
        </ul>
        <p>
          Information from others: our payment provider (Mollie) tells us whether a payment
          succeeded, and our delivery partners tell us the status of your parcel. We never receive
          or store your full card number.
        </p>
      </LegalSection>

      <LegalSection id="why" heading="4. Why we use it, and our lawful basis">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-[var(--brand-ink)]">To process and deliver your order</strong>,
            handle returns and provide support — necessary for performance of our contract with you.
          </li>
          <li>
            <strong className="text-[var(--brand-ink)]">To prevent and detect fraud</strong>, keep
            the site secure, and improve our products and site design — our legitimate interests in
            running the business safely and well.
          </li>
          <li>
            <strong className="text-[var(--brand-ink)]">To send marketing emails</strong> about
            products and promotions — your consent, which you can withdraw at any time.
          </li>
          <li>
            <strong className="text-[var(--brand-ink)]">To tell you an item is back in stock</strong>{' '}
            — your consent, given when you submit the notify-me form.
          </li>
          <li>
            <strong className="text-[var(--brand-ink)]">To keep accounting and tax records</strong> —
            necessary for compliance with our legal obligations.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="ai" heading="5. On-site search and assistant">
        <p>
          Our search bar and filament assistant use a third-party AI model to interpret what you are
          asking for. Only the text of your query is sent to the model provider — we do not send your
          name, email address, IP address, order history or any other identifying information, and
          the query log we keep for cost monitoring contains no fields that could identify you.
        </p>
        <p>Please do not type personal or sensitive information into the assistant.</p>
      </LegalSection>

      <LegalSection id="sharing" heading="6. Who we share it with">
        <p>To make our service work we share personal information with:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>IT and hosting providers who run our site and systems;</li>
          <li>Mollie, our payment provider, to take payment;</li>
          <li>delivery companies, to get your parcel to you;</li>
          <li>our email provider, to send order confirmations and any marketing you opted into;</li>
          <li>professional advisers and, where we are legally required to, regulators or law enforcement.</li>
        </ul>
        <p>
          We impose contractual obligations on these providers relating to data protection and
          security. They may only use your data to provide services to us and to you, and for no
          other purpose. We do not sell your personal information.
        </p>
      </LegalSection>

      <LegalSection id="transfers" heading="7. International transfers">
        <p>
          Some of our service providers are located outside the UK. Where personal information is
          transferred outside the UK, we ensure a similar degree of protection applies — either
          because the destination is covered by UK adequacy regulations, or by using approved
          contractual safeguards such as the International Data Transfer Agreement.
        </p>
      </LegalSection>

      <LegalSection id="retention" heading="8. How long we keep it">
        <p>
          We keep personal information no longer than necessary for the purpose it was collected
          for. Different retention periods apply to different types of data: order and transaction
          records are kept for seven years to meet tax and accounting obligations, marketing consents
          until you withdraw them, and general enquiries for a shorter period. Information no longer
          needed is securely deleted.
        </p>
      </LegalSection>

      <LegalSection id="cookies" heading="9. Cookies">
        <p>
          This site uses cookies to keep your basket working, to remember your preferences, and to
          help us understand how the site is used so we can improve it. You can remove or disable
          cookies in your browser at any time, but if you disable the essential ones the basket and
          checkout will not work.
        </p>
      </LegalSection>

      <LegalSection id="marketing" heading="10. Marketing">
        <p>
          With your permission we will send you information about products and services that may
          interest you. You have the right at any time to stop us contacting you for marketing
          purposes — use the unsubscribe link at the foot of every email we send, or email{' '}
          <a href={`mailto:${LEGAL.contactEmail}`} className="text-[var(--brand-ink)] underline">
            {LEGAL.contactEmail}
          </a>
          . Withdrawing consent does not stop transactional messages about an order you have placed.
        </p>
      </LegalSection>

      <LegalSection id="rights" heading="11. Your rights">
        <p>Under data protection law you have the right to:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>be told how your data is used and to request a copy of it;</li>
          <li>have inaccurate data corrected;</li>
          <li>have data erased, where there is no good reason for us to continue holding it;</li>
          <li>object to processing based on our legitimate interests, and to direct marketing at any time;</li>
          <li>ask us to restrict processing while a concern is investigated;</li>
          <li>receive the data you gave us in a portable format, or have it sent to another controller; and</li>
          <li>withdraw consent at any time, where we rely on consent.</li>
        </ul>
        <p>
          Make a request by emailing{' '}
          <a href={`mailto:${LEGAL.contactEmail}`} className="text-[var(--brand-ink)] underline">
            {LEGAL.contactEmail}
          </a>
          . We will respond within one month. In most cases we provide the information free of
          charge; where a request is manifestly unfounded or excessive we may charge a reasonable fee
          or refuse it, and if we refuse we will explain why and tell you how to complain.
        </p>
      </LegalSection>

      <LegalSection id="complaints" heading="12. Complaints">
        <p>
          If you are unhappy with how we have handled your personal information, please tell us first
          so we can put it right. You also have the right to complain to the Information
          Commissioner&rsquo;s Office, the UK supervisory authority, at ico.org.uk or on 0303 123
          1113.
        </p>
      </LegalSection>

      <LegalSection id="changes" heading="13. Changes to this policy">
        <p>
          We review this policy regularly and update it to reflect any change in how we collect and
          use personal data. This policy was last updated in {LEGAL.lastUpdated}. Questions, comments
          and requests should be addressed to{' '}
          <a href={`mailto:${LEGAL.contactEmail}`} className="text-[var(--brand-ink)] underline">
            {LEGAL.contactEmail}
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
