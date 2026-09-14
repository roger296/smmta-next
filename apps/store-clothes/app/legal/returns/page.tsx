/**
 * /legal/returns — returns & cancellations policy.
 *
 * Linked from the checkout consent tickbox, so it must always resolve.
 *
 * Same structure as the Filament Store policy: STATUTORY rights first (the
 * 14-day distance-selling cancellation right and the Consumer Rights Act 2015
 * right to reject faulty goods), then the GOODWILL policy layered on top
 * (28 days, unworn items). Clothing replaces the sealed-spool rule, and
 * sealed hygiene items use the exception in Reg. 28(1)(e) of the Consumer
 * Contracts Regulations 2013.
 */
import type { Metadata } from 'next';
import { LEGAL } from '@/lib/legal';
import { ContactEmail, LegalPage, LegalSection } from '../_components/legal-page';

export const revalidate = 86_400;

export const metadata: Metadata = {
  title: 'Returns & cancellations',
  description:
    'How to return or cancel a Clothes Shop order: your statutory cancellation rights, our 28-day returns policy for unworn items, faulty goods, and refunds.',
  alternates: { canonical: '/legal/returns' },
  robots: { index: true, follow: true },
};

export default function ReturnsPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Returns & cancellations"
      intro="Wrong size, changed your mind, or something not right? Here is exactly what you can return, when, and who pays the postage."
    >
      <LegalSection id="summary" heading="The short version">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-[var(--brand-ink)]">Unworn, with tags on?</strong> Return it
            within {LEGAL.returnsWindowDays} days of delivery for a full refund of the item price.
          </li>
          <li>
            <strong className="text-[var(--brand-ink)]">Worn, washed or tags removed?</strong> We
            cannot take it back unless it is faulty.
          </li>
          <li>
            <strong className="text-[var(--brand-ink)]">Faulty or not as described?</strong> Always
            returnable, and we pay the postage.
          </li>
          <li>
            <strong className="text-[var(--brand-ink)]">Return postage</strong> is paid by you unless
            the item is faulty, damaged, or we sent the wrong thing.
          </li>
          <li>
            <strong className="text-[var(--brand-ink)]">Please contact us before sending anything</strong>{' '}
            — we&rsquo;ll give you a returns reference and tell you where to send it.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="statutory" heading="Your statutory cancellation right">
        <p>
          Because you are buying online, the Consumer Contracts (Information, Cancellation and
          Additional Charges) Regulations 2013 give you the right to cancel your order within{' '}
          {LEGAL.statutoryCancellationDays} days of receiving the goods, without giving a reason.
          Nothing on this page removes that right.
        </p>
        <p>
          To cancel, email <ContactEmail /> with your order number before the{' '}
          {LEGAL.statutoryCancellationDays} days are up. You then have a further{' '}
          {LEGAL.statutoryCancellationDays} days to send the goods back. You are responsible for the
          cost of returning them.
        </p>
        <p>
          You may try an item on as you would in a shop. Where goods come back worn, washed, marked
          or with their tags removed — handled more than was needed to check their size, fit and
          quality — we may reduce the refund to reflect the loss in value.
        </p>
        <p>
          Items sealed for hygiene reasons, such as underwear, socks and face coverings, cannot be
          returned once unsealed after delivery unless they are faulty.
        </p>
      </LegalSection>

      <LegalSection id="goodwill" heading={`Our ${LEGAL.returnsWindowDays}-day returns policy`}>
        <p>
          Beyond the statutory window we offer a longer goodwill period. You may return an item within{' '}
          <strong className="text-[var(--brand-ink)]">{LEGAL.returnsWindowDays} days of delivery</strong>{' '}
          provided it is:
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>unworn (other than trying it on), unwashed and undamaged;</li>
          <li>with its original tags and labels attached and in its original packaging; and</li>
          <li>in a resalable condition.</li>
        </ul>
        <p>
          We cannot accept returns requested more than {LEGAL.returnsWindowDays} days after delivery.
        </p>
      </LegalSection>

      <LegalSection id="faulty" heading="Faulty, damaged or wrong items">
        <p>
          Under the Consumer Rights Act 2015 goods must be of satisfactory quality, fit for purpose
          and as described. If an item fails that standard — a manufacturing fault, damage in transit,
          or simply the wrong item or size — you can return it whether or not it has been worn.
        </p>
        <p>
          Tell us within 30 days of delivery and you are entitled to a full refund. After 30 days we
          will repair or replace it, and if that is not possible you can claim a refund. Email{' '}
          <ContactEmail /> with your order number and a photo of the problem.
        </p>
        <p>
          <strong className="text-[var(--brand-ink)]">We pay return postage on faulty, damaged or
          incorrectly supplied items</strong> and will send you a prepaid label.
        </p>
      </LegalSection>

      <LegalSection id="how" heading="How to return something">
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            Email <ContactEmail /> with your order number and what you would like to return. Please do
            not send anything back before contacting us: our items come from several supplier
            partners, and we need to give you a returns reference and the right address so your
            parcel can be matched to your order.
          </li>
          <li>We will reply with a returns reference and address, normally within one working day.</li>
          <li>
            Pack the item so it arrives as it left, with its tags on. Include the returns reference in
            the parcel.
          </li>
          <li>
            Send it using a tracked service. Until it reaches us the parcel is your responsibility,
            and without tracking we cannot refund an item that goes missing in transit.
          </li>
        </ol>
      </LegalSection>

      <LegalSection id="postage" heading="Who pays the postage">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-[var(--brand-ink)]">Changed your mind or wrong size ordered:</strong>{' '}
            you pay the return postage.
          </li>
          <li>
            <strong className="text-[var(--brand-ink)]">Faulty, damaged, or our mistake:</strong> we
            pay, via a prepaid label.
          </li>
        </ul>
        <p>
          Where you cancel a whole order under your statutory right, we refund the delivery charge you
          paid. Where you return part of an order, the delivery charge is not refunded.
        </p>
      </LegalSection>

      <LegalSection id="refunds" heading="Refunds">
        <p>
          Refunds are issued to the original payment method within 14 days of us receiving the goods
          back (or, if earlier, of you supplying proof of postage). How quickly the money appears
          depends on your bank or card issuer.
        </p>
        <p>
          If a returned item arrives worn, damaged, or outside the {LEGAL.returnsWindowDays}-day
          window, we will contact you before doing anything. We will either return it to you at your
          cost or, where a partial refund is fair, offer you one — the choice is yours.
        </p>
      </LegalSection>

      <LegalSection id="contact" heading="Contact">
        <p>
          Returns and everything else: <ContactEmail />
        </p>
        <p>
          {LEGAL.legalEntity} (trading as {LEGAL.parentName}), {LEGAL.registeredAddress}. Registered
          in England and Wales, company number {LEGAL.companyNumber}.
          {LEGAL.vatNumber ? ` VAT registration number ${LEGAL.vatNumber}.` : ''}
        </p>
      </LegalSection>
    </LegalPage>
  );
}
