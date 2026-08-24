/**
 * /legal/returns — returns & cancellations policy.
 *
 * Linked from the checkout consent tickbox, so it must always resolve.
 *
 * Structure deliberately separates two things that customers (and traders)
 * routinely conflate:
 *   1. STATUTORY rights that cannot be contracted away — the 14-day distance
 *      selling cancellation right (Consumer Contracts Regulations 2013) and the
 *      Consumer Rights Act 2015 right to reject faulty goods.
 *   2. The GOODWILL policy layered on top (28 days, sealed spools only).
 *
 * Presenting the commercial policy without acknowledging (1) is what makes a
 * returns policy unenforceable, so the statutory section comes first.
 */
import type { Metadata } from 'next';
import { LEGAL } from '@/lib/legal';
import { LegalPage, LegalSection } from '../_components/legal-page';

export const revalidate = 86_400;

export const metadata: Metadata = {
  title: 'Returns & cancellations',
  description:
    'How to return or cancel a Filament Store order: your statutory cancellation rights, our 28-day sealed-spool returns policy, faulty goods, and refunds.',
  alternates: { canonical: '/legal/returns' },
  robots: { index: true, follow: true },
};

export default function ReturnsPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Returns & cancellations"
      intro="Filament is a material that degrades once it meets the air, so our policy is stricter than most. Here is exactly what you can return, when, and who pays the postage."
    >
      <LegalSection id="summary" heading="The short version">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-[var(--brand-ink)]">Unopened, still sealed?</strong> Return it
            within {LEGAL.returnsWindowDays} days of delivery for a full refund of the item price.
          </li>
          <li>
            <strong className="text-[var(--brand-ink)]">Opened or unsealed?</strong> We cannot accept
            it back unless it is faulty — see &ldquo;Why we can&rsquo;t take back opened
            spools&rdquo; below.
          </li>
          <li>
            <strong className="text-[var(--brand-ink)]">Faulty or not as described?</strong> Always
            returnable, and we pay the postage.
          </li>
          <li>
            <strong className="text-[var(--brand-ink)]">Return postage</strong> is paid by you unless
            the item is faulty, damaged, or we sent the wrong thing.
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
          To cancel, email{' '}
          <a href={`mailto:${LEGAL.returnsEmail}`} className="text-[var(--brand-ink)] underline">
            {LEGAL.returnsEmail}
          </a>{' '}
          with your order number before the {LEGAL.statutoryCancellationDays} days are up. You then
          have a further {LEGAL.statutoryCancellationDays} days to send the goods back. You are
          responsible for the cost of returning them.
        </p>
        <p>
          Where goods are returned to us having been handled more than was necessary to establish
          their nature, characteristics and functioning, we may reduce the refund to reflect the
          resulting loss in value. For vacuum-sealed filament, breaking the seal is not necessary to
          establish those things — the material, diameter, weight and colour are all printed on the
          packaging.
        </p>
      </LegalSection>

      <LegalSection id="goodwill" heading={`Our ${LEGAL.returnsWindowDays}-day returns policy`}>
        <p>
          Beyond the statutory window we offer a longer goodwill period. You may return any spool
          within <strong className="text-[var(--brand-ink)]">{LEGAL.returnsWindowDays} days of
          delivery</strong> provided it is:
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>still in its original, unbroken vacuum seal;</li>
          <li>in its original undamaged box, with any desiccant sachet still inside; and</li>
          <li>in a resalable condition.</li>
        </ul>
        <p>
          We cannot accept returns requested more than {LEGAL.returnsWindowDays} days after delivery.
        </p>
      </LegalSection>

      <LegalSection id="opened" heading="Why we can’t take back opened spools">
        <p>
          Filament is hygroscopic — it starts absorbing atmospheric moisture the moment the vacuum
          seal is broken. Damp filament prints badly: stringing, popping, weak layer adhesion and
          brittle parts. Once a spool has been unsealed we have no way of knowing how long it was
          exposed or how it was stored, and we will not resell material we would not print with
          ourselves.
        </p>
        <p>
          So an unsealed spool cannot be returned simply because you have changed your mind. If an
          unsealed spool is faulty, that is a different matter entirely and is covered below.
        </p>
      </LegalSection>

      <LegalSection id="faulty" heading="Faulty, damaged or wrong items">
        <p>
          Under the Consumer Rights Act 2015 goods must be of satisfactory quality, fit for purpose
          and as described. If a spool fails that standard — inconsistent diameter, contamination,
          a snapped or tangled winding, damage in transit, or simply the wrong item — you can return
          it whether or not the seal is broken.
        </p>
        <p>
          Tell us within 30 days of delivery and you are entitled to a full refund. After 30 days we
          will repair or replace it, and if that is not possible you can claim a refund. Email{' '}
          <a href={`mailto:${LEGAL.returnsEmail}`} className="text-[var(--brand-ink)] underline">
            {LEGAL.returnsEmail}
          </a>{' '}
          with your order number and a photo of the problem — photographs of the print failure and
          the affected filament help us diagnose it quickly.
        </p>
        <p>
          <strong className="text-[var(--brand-ink)]">We pay return postage on faulty, damaged or
          incorrectly supplied items</strong> and will send you a prepaid label.
        </p>
      </LegalSection>

      <LegalSection id="how" heading="How to return something">
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            Email{' '}
            <a href={`mailto:${LEGAL.returnsEmail}`} className="text-[var(--brand-ink)] underline">
              {LEGAL.returnsEmail}
            </a>{' '}
            with your order number and what you would like to return. Please do not send anything
            back before contacting us — we need to issue a returns reference so your parcel can be
            matched to your order.
          </li>
          <li>
            We will reply with a returns reference, normally within one working day. Returns are
            received at{' '}
            <span className="text-[var(--brand-ink)]">{LEGAL.returnsAddress}</span> — please still
            ask for a reference before sending anything, so your parcel can be matched to your
            order.
          </li>
          <li>
            Pack the spool so it arrives as it left — the original box is ideal. Include the returns
            reference in the parcel.
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
            <strong className="text-[var(--brand-ink)]">Changed your mind:</strong> you pay the
            return postage.
          </li>
          <li>
            <strong className="text-[var(--brand-ink)]">Faulty, damaged, or our mistake:</strong> we
            pay, via a prepaid label.
          </li>
        </ul>
        <p>
          Where you cancel a whole order under your statutory right, we refund the standard outbound
          delivery charge you paid. If you chose a more expensive delivery option, we refund the
          standard rate only. Where you return part of an order, the outbound delivery charge is not
          refunded.
        </p>
      </LegalSection>

      <LegalSection id="refunds" heading="Refunds">
        <p>
          Refunds are issued to the original payment method within 14 days of us receiving the goods
          back (or, if earlier, of you supplying proof of postage). How quickly the money appears
          depends on your bank or card issuer.
        </p>
        <p>
          If a returned spool arrives unsealed, damaged, or outside the{' '}
          {LEGAL.returnsWindowDays}-day window, we will contact you before doing anything. We will
          either return it to you at your cost or, where a partial refund is fair, offer you one —
          the choice is yours.
        </p>
      </LegalSection>

      <LegalSection id="contact" heading="Contact">
        <p>
          Returns:{' '}
          <a href={`mailto:${LEGAL.returnsEmail}`} className="text-[var(--brand-ink)] underline">
            {LEGAL.returnsEmail}
          </a>
          <br />
          Everything else:{' '}
          <a href={`mailto:${LEGAL.ordersEmail}`} className="text-[var(--brand-ink)] underline">
            {LEGAL.ordersEmail}
          </a>
          <br />
          Returns address:{' '}
          <span className="text-[var(--brand-ink)]">{LEGAL.returnsAddress}</span>
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
