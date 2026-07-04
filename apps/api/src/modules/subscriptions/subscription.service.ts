/**
 * Subscriptions (SPEC F4, §13.7, §15.4, §16). Mollie-mandate subscriptions with
 * the credit-bonus model and worker-owned billing + dunning. The mandate is
 * payment authority only; the schedule, retries, and credit logic are ours.
 *
 * Money is integer pence. Credit conservation holds by construction: every
 * balance change writes a subscription_events row with a signed `amount_pence`,
 * so sum(amount_pence) always equals credit_balance_pence.
 */
import { and, eq, lte, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { subscriptions, subscriptionEvents } from '../../db/schema/index.js';
import { emitDomainEvent, type DbTx } from '../../shared/events/emit.js';
import { getMollie } from '../../integrations/mollie/index.js';
import { ComposeService } from '../messaging/compose.service.js';
import { getPlan, RENEWAL_INTERVAL_DAYS, DUNNING_LADDER_DAYS } from './plans.js';

const DAY_MS = 86_400_000;

export class SubscriptionService {
  private db = getDb();
  private companyId = getSingletonCompanyId();
  private compose: ComposeService;

  constructor(compose?: ComposeService) {
    this.compose = compose ?? new ComposeService();
  }

  /** Establish the mandate: a first payment (sequenceType=first). */
  async signup(userId: string, planKey: string) {
    const plan = getPlan(planKey);
    const customer = await getMollie().createCustomer({});
    const payment = await getMollie().createPayment({
      amountPence: plan.monthlyChargePence,
      description: `Subscription ${planKey} — first payment`,
      sequenceType: 'first',
      customerId: customer.id,
      metadata: { kind: 'subscription_signup', userId, plan: planKey },
    });
    return { paymentId: payment.id, customerId: customer.id };
  }

  /** On the paid first-payment webhook: create the subscription + grant the
   *  first credit. Idempotent per Mollie customer. */
  async activateFromPayment(molliePaymentId: string, nowMs = Date.now()): Promise<void> {
    const payment = await getMollie().getPayment(molliePaymentId);
    if (payment.status !== 'paid') return;
    const meta = payment.metadata as { kind?: string; userId?: string; plan?: string };
    if (meta.kind !== 'subscription_signup' || !meta.userId || !meta.plan) return;

    const [existing] = await this.db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(eq(subscriptions.mollieCustomerId, payment.customerId ?? ''))
      .limit(1);
    if (existing) return; // idempotent

    const plan = getPlan(meta.plan);
    const mandateId = `mdt_${payment.customerId}`;
    await this.db.transaction(async (tx) => {
      const [sub] = await tx
        .insert(subscriptions)
        .values({
          companyId: this.companyId,
          userId: meta.userId!,
          mollieCustomerId: payment.customerId!,
          mollieMandateId: mandateId,
          plan: meta.plan!,
          status: 'active',
          renewsAt: new Date(nowMs + RENEWAL_INTERVAL_DAYS * DAY_MS),
        })
        .returning();
      await this.grantCredit(tx, sub!.id, plan.creditGrantPence, 'signup');
      await emitDomainEvent(tx, {
        eventType: 'subscription.created',
        aggregateType: 'subscription',
        aggregateId: sub!.id,
        payload: { subscriptionId: sub!.id, plan: meta.plan, userId: meta.userId },
      });
    });
  }

  private async grantCredit(tx: DbTx, subId: string, amountPence: number, reason: string): Promise<void> {
    await tx
      .update(subscriptions)
      .set({ creditBalancePence: sql`${subscriptions.creditBalancePence} + ${amountPence}`, updatedAt: new Date() })
      .where(eq(subscriptions.id, subId));
    await tx
      .insert(subscriptionEvents)
      .values({ companyId: this.companyId, subscriptionId: subId, kind: 'credit_grant', amountPence, detail: { reason } });
  }

  private async spendCreditTx(tx: DbTx, subId: string, amountPence: number): Promise<void> {
    await tx
      .update(subscriptions)
      .set({ creditBalancePence: sql`${subscriptions.creditBalancePence} - ${amountPence}`, updatedAt: new Date() })
      .where(eq(subscriptions.id, subId));
    await tx
      .insert(subscriptionEvents)
      .values({ companyId: this.companyId, subscriptionId: subId, kind: 'credit_spend', amountPence: -amountPence });
  }

  /**
   * Apply available credit to a checkout amount. Consumes min(balance, amount)
   * at normal prices (credits are money-equivalent; no discount interaction).
   * Returns the credit used and the residual to charge via Mollie.
   */
  async applyCredit(userId: string, amountPence: number): Promise<{ creditUsedPence: number; remainingPence: number }> {
    return this.db.transaction(async (tx) => {
      const [sub] = await tx
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, userId), eq(subscriptions.status, 'active')))
        .for('update')
        .limit(1);
      if (!sub || sub.creditBalancePence <= 0) return { creditUsedPence: 0, remainingPence: amountPence };
      const creditUsedPence = Math.min(sub.creditBalancePence, amountPence);
      if (creditUsedPence > 0) await this.spendCreditTx(tx, sub.id, creditUsedPence);
      return { creditUsedPence, remainingPence: amountPence - creditUsedPence };
    });
  }

  /** subscription-renewal-scan: charge due mandates; paid → credit + advance. */
  async renewalScan(nowMs = Date.now()): Promise<{ charged: number; failed: number }> {
    const due = await this.db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.companyId, this.companyId),
          eq(subscriptions.status, 'active'),
          lte(subscriptions.renewsAt, new Date(nowMs)),
        ),
      );
    let charged = 0;
    let failed = 0;
    for (const sub of due) {
      const plan = getPlan(sub.plan);
      const payment = await getMollie().chargeMandate({
        customerId: sub.mollieCustomerId,
        mandateId: sub.mollieMandateId!,
        amountPence: plan.monthlyChargePence,
        description: `Subscription ${sub.plan} renewal`,
        metadata: { kind: 'subscription_renewal', subscriptionId: sub.id, cycle: sub.renewsAt?.toISOString() },
      });
      if (payment.status === 'paid') {
        await this.db.transaction(async (tx) => {
          await this.grantCredit(tx, sub.id, plan.creditGrantPence, 'renewal');
          await tx
            .update(subscriptions)
            .set({
              renewsAt: new Date((sub.renewsAt?.getTime() ?? nowMs) + RENEWAL_INTERVAL_DAYS * DAY_MS),
              dunningAttempts: 0,
              firstFailedAt: null,
              lastAttemptAt: null,
              updatedAt: new Date(),
            })
            .where(eq(subscriptions.id, sub.id));
        });
        charged++;
      } else {
        await this.db.transaction(async (tx) => {
          await tx
            .update(subscriptions)
            .set({ status: 'past_due', firstFailedAt: new Date(nowMs), lastAttemptAt: new Date(nowMs), dunningAttempts: 0, updatedAt: new Date() })
            .where(eq(subscriptions.id, sub.id));
          await emitDomainEvent(tx, {
            eventType: 'subscription.payment_failed',
            aggregateType: 'subscription',
            aggregateId: sub.id,
            payload: { subscriptionId: sub.id, attempt: 0 },
          });
        });
        failed++;
      }
    }
    return { charged, failed };
  }

  /**
   * payment-retry (dunning, §16.4): re-attempt at day 1/3/5 after the first
   * failure; on success → active; after the final attempt fails → pause + a
   * personal-tone compose. Idempotent per (sub, attempt) via the ladder spacing.
   */
  async paymentRetry(nowMs = Date.now()): Promise<{ recovered: number; paused: number }> {
    const pastDue = await this.db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.companyId, this.companyId), eq(subscriptions.status, 'past_due')));

    let recovered = 0;
    let paused = 0;
    for (const sub of pastDue) {
      const firstFailed = sub.firstFailedAt?.getTime();
      if (firstFailed == null) continue;
      const attempt = sub.dunningAttempts; // number of retries already made
      if (attempt >= DUNNING_LADDER_DAYS.length) continue; // ladder exhausted
      const dueAt = firstFailed + DUNNING_LADDER_DAYS[attempt]! * DAY_MS;
      if (nowMs < dueAt) continue; // not yet time for this attempt

      const plan = getPlan(sub.plan);
      const payment = await getMollie().chargeMandate({
        customerId: sub.mollieCustomerId,
        mandateId: sub.mollieMandateId!,
        amountPence: plan.monthlyChargePence,
        description: `Subscription ${sub.plan} dunning attempt ${attempt + 1}`,
        metadata: { kind: 'subscription_dunning', subscriptionId: sub.id, attempt: attempt + 1 },
      });

      if (payment.status === 'paid') {
        await this.db.transaction(async (tx) => {
          await this.grantCredit(tx, sub.id, plan.creditGrantPence, 'dunning_recovery');
          await tx
            .update(subscriptions)
            .set({
              status: 'active',
              renewsAt: new Date(nowMs + RENEWAL_INTERVAL_DAYS * DAY_MS),
              dunningAttempts: 0,
              firstFailedAt: null,
              lastAttemptAt: null,
              updatedAt: new Date(),
            })
            .where(eq(subscriptions.id, sub.id));
        });
        recovered++;
      } else {
        const nextAttempt = attempt + 1;
        const exhausted = nextAttempt >= DUNNING_LADDER_DAYS.length;
        await this.db.transaction(async (tx) => {
          await tx
            .update(subscriptions)
            .set({
              dunningAttempts: nextAttempt,
              lastAttemptAt: new Date(nowMs),
              status: exhausted ? 'paused' : 'past_due',
              updatedAt: new Date(),
            })
            .where(eq(subscriptions.id, sub.id));
          if (exhausted) {
            await emitDomainEvent(tx, {
              eventType: 'subscription.modified',
              aggregateType: 'subscription',
              aggregateId: sub.id,
              payload: { subscriptionId: sub.id, change: 'paused_after_dunning' },
            });
          }
        });
        if (exhausted) {
          await this.compose.compose({
            userId: sub.userId,
            templateKey: 'lapsed_winback',
            facts: { reason: 'subscription_payment_failed', plan: sub.plan },
          });
          paused++;
        }
      }
    }
    return { recovered, paused };
  }

  async pause(subId: string): Promise<void> {
    await this.modify(subId, 'paused', 'pause');
  }
  async resume(subId: string): Promise<void> {
    await this.modify(subId, 'active', 'resume');
  }

  private async modify(subId: string, status: 'active' | 'paused', kind: 'pause' | 'resume'): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(subscriptions).set({ status, updatedAt: new Date() }).where(eq(subscriptions.id, subId));
      await tx
        .insert(subscriptionEvents)
        .values({ companyId: this.companyId, subscriptionId: subId, kind });
      await emitDomainEvent(tx, {
        eventType: 'subscription.modified',
        aggregateType: 'subscription',
        aggregateId: subId,
        payload: { subscriptionId: subId, change: kind },
      });
    });
  }
}
