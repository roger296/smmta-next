/**
 * Subscription tests (Prompt 13, SPEC F4, §15.4, §16). Real Postgres; Mollie
 * fake (with mandate-charge control) + FakeLlm for the dunning compose.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { storefrontUsers, subscriptions, subscriptionEvents, messageDrafts } from '../../db/schema/index.js';
import { SubscriptionService } from './subscription.service.js';
import { getPlan } from './plans.js';
import { getMollie } from '../../integrations/mollie/index.js';
import { FakeMollie } from '../../integrations/mollie/mollie.fake.js';
import { ComposeService } from '../messaging/compose.service.js';
import { OpenRouterService } from '../../integrations/openrouter/openrouter.service.js';
import { FakeLlm } from '../../integrations/openrouter/openrouter.fake.js';

const COMPANY = getSingletonCompanyId();
const DAY = 86_400_000;
let seq = 0;

function svc(): SubscriptionService {
  const fake = new FakeLlm();
  for (let i = 0; i < 5; i++) fake.enqueue({ content: JSON.stringify({ subject: 's', body: 'b' }) });
  return new SubscriptionService(new ComposeService(new OpenRouterService(fake)));
}

async function makeUser(): Promise<string> {
  const [u] = await getDb()
    .insert(storefrontUsers)
    .values({ companyId: COMPANY, email: `sub-${Date.now()}-${++seq}@example.test`, kind: 'account' })
    .returning({ id: storefrontUsers.id });
  return u!.id;
}

/** Sign up + drive the first payment to paid + activate. Returns sub id. */
async function activeSubscription(userId: string, plan = 'starter', nowMs = Date.now()): Promise<string> {
  const s = svc();
  const { paymentId } = await s.signup(userId, plan);
  (getMollie() as FakeMollie).setStatus(paymentId, 'paid');
  await s.activateFromPayment(paymentId, nowMs);
  const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.userId, userId));
  return sub!.id;
}

async function balanceEqualsEvents(subId: string): Promise<void> {
  const db = getDb();
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, subId));
  const events = await db.select().from(subscriptionEvents).where(eq(subscriptionEvents.subscriptionId, subId));
  const sum = events.reduce((s, e) => s + (e.amountPence ?? 0), 0);
  expect(sub!.creditBalancePence).toBe(sum); // conservation: balance == Σ event amounts
}

afterEach(async () => {
  const db = getDb();
  (getMollie() as FakeMollie).reset();
  const users = await db.select({ id: storefrontUsers.id }).from(storefrontUsers).where(like(storefrontUsers.email, 'sub-%@example.test'));
  const ids = users.map((u) => u.id);
  if (ids.length) {
    const subs = await db.select({ id: subscriptions.id }).from(subscriptions).where(inArray(subscriptions.userId, ids));
    const sids = subs.map((s) => s.id);
    if (sids.length) await db.delete(subscriptionEvents).where(inArray(subscriptionEvents.subscriptionId, sids));
    await db.delete(messageDrafts).where(inArray(messageDrafts.userId, ids));
    await db.delete(subscriptions).where(inArray(subscriptions.userId, ids));
    await db.delete(storefrontUsers).where(inArray(storefrontUsers.id, ids));
  }
});

afterAll(async () => {
  await closeDatabase();
});

describe('signup + activation', () => {
  it('activates on the paid first payment and grants the first credit (idempotent)', async () => {
    const userId = await makeUser();
    const s = svc();
    const { paymentId } = await s.signup(userId, 'starter');
    (getMollie() as FakeMollie).setStatus(paymentId, 'paid');
    await s.activateFromPayment(paymentId);
    await s.activateFromPayment(paymentId); // duplicate webhook

    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.userId, userId));
    expect(sub!.status).toBe('active');
    expect(sub!.creditBalancePence).toBe(getPlan('starter').creditGrantPence); // £23, once
    await balanceEqualsEvents(sub!.id);
  });
});

describe('renewal + credit conservation', () => {
  it('charges due mandates, grants credit, advances renewsAt; balance == Σ events', async () => {
    const userId = await makeUser();
    const NOW = Date.parse('2026-07-04T00:00:00Z');
    const subId = await activeSubscription(userId, 'starter', NOW);

    // Not due yet.
    expect((await svc().renewalScan(NOW)).charged).toBe(0);
    // Due after 30 days.
    const later = NOW + 31 * DAY;
    const res = await svc().renewalScan(later);
    expect(res.charged).toBe(1);
    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.id, subId));
    expect(sub!.creditBalancePence).toBe(getPlan('starter').creditGrantPence * 2); // two grants
    await balanceEqualsEvents(subId);
  });
});

describe('dunning ladder', () => {
  it('retries at day 1/3/5 then pauses; recovers if a retry succeeds', async () => {
    const userId = await makeUser();
    const NOW = Date.parse('2026-07-04T00:00:00Z');
    const subId = await activeSubscription(userId, 'starter', NOW);
    const mollie = getMollie() as FakeMollie;
    const [sub0] = await getDb().select().from(subscriptions).where(eq(subscriptions.id, subId));
    mollie.setMandateCharges(sub0!.mollieMandateId!, 'failed');

    // Renewal fails → past_due.
    const due = NOW + 31 * DAY;
    await svc().renewalScan(due);
    let [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.id, subId));
    expect(sub!.status).toBe('past_due');
    const firstFail = sub!.firstFailedAt!.getTime();

    // Before day 1 → no attempt.
    expect((await svc().paymentRetry(firstFail + 0.5 * DAY)).paused).toBe(0);
    // Day 1 attempt fails.
    await svc().paymentRetry(firstFail + 1 * DAY);
    // Day 3 attempt fails.
    await svc().paymentRetry(firstFail + 3 * DAY);
    // Day 5 attempt fails → pause.
    const final = await svc().paymentRetry(firstFail + 5 * DAY);
    expect(final.paused).toBe(1);
    [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.id, subId));
    expect(sub!.status).toBe('paused');
  });

  it('a successful retry recovers the subscription', async () => {
    const userId = await makeUser();
    const NOW = Date.parse('2026-07-04T00:00:00Z');
    const subId = await activeSubscription(userId, 'starter', NOW);
    const mollie = getMollie() as FakeMollie;
    const [sub0] = await getDb().select().from(subscriptions).where(eq(subscriptions.id, subId));
    mollie.setMandateCharges(sub0!.mollieMandateId!, 'failed');
    await svc().renewalScan(NOW + 31 * DAY);
    const [f] = await getDb().select().from(subscriptions).where(eq(subscriptions.id, subId));
    const firstFail = f!.firstFailedAt!.getTime();

    mollie.setMandateCharges(sub0!.mollieMandateId!, 'paid'); // bank recovers
    const res = await svc().paymentRetry(firstFail + 1 * DAY);
    expect(res.recovered).toBe(1);
    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.id, subId));
    expect(sub!.status).toBe('active');
    await balanceEqualsEvents(subId);
  });
});

describe('pause blocks the renewal scan; credit checkout', () => {
  it('a paused sub is not charged but retains its balance', async () => {
    const userId = await makeUser();
    const NOW = Date.parse('2026-07-04T00:00:00Z');
    const subId = await activeSubscription(userId, 'starter', NOW);
    const s = svc();
    await s.pause(subId);
    const before = (await getDb().select().from(subscriptions).where(eq(subscriptions.id, subId)))[0]!.creditBalancePence;
    const res = await s.renewalScan(NOW + 31 * DAY);
    expect(res.charged).toBe(0);
    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.id, subId));
    expect(sub!.status).toBe('paused');
    expect(sub!.creditBalancePence).toBe(before); // balance retained
  });

  it('applyCredit consumes exact / partial / zero credit correctly', async () => {
    const userId = await makeUser();
    const subId = await activeSubscription(userId, 'starter'); // £23 = 2300p credit
    const s = new SubscriptionService();

    // Partial: charge 1000p → 1000 credit used, 0 to pay.
    expect(await s.applyCredit(userId, 1000)).toEqual({ creditUsedPence: 1000, remainingPence: 0 });
    // Exact remaining: 1300 left → charge 1300 → 1300 used, 0 remaining.
    expect(await s.applyCredit(userId, 1300)).toEqual({ creditUsedPence: 1300, remainingPence: 0 });
    // Now zero balance → charge 500 → 0 credit, 500 to pay via Mollie.
    expect(await s.applyCredit(userId, 500)).toEqual({ creditUsedPence: 0, remainingPence: 500 });
    await balanceEqualsEvents(subId);
    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.id, subId));
    expect(sub!.creditBalancePence).toBe(0);
  });
});
