/**
 * Marketing-agent tests (Prompt 12, SPEC F7, §12.3). Cadence math (pure) +
 * segmentation gates against real Postgres.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { eq, inArray, like, sql } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import {
  storefrontUsers,
  consentRecords,
  suppressionList,
  interestFlags,
  messageDrafts,
  runOutPredictions,
} from '../../db/schema/index.js';
import { medianIntervalDays, predictRunOut } from './cadence.js';
import { MarketingService } from './marketing.service.js';
import { ComposeService } from '../messaging/compose.service.js';
import { OpenRouterService } from '../../integrations/openrouter/openrouter.service.js';
import { FakeLlm } from '../../integrations/openrouter/openrouter.fake.js';

const COMPANY = getSingletonCompanyId();
const DAY = 86_400_000;
const NOW = Date.parse('2026-07-04T00:00:00Z');
let seq = 0;
const email = () => `mkt-${Date.now()}-${++seq}@example.test`;

function marketerWith(turns: number): MarketingService {
  const fake = new FakeLlm();
  for (let i = 0; i < turns; i++) fake.enqueue({ content: JSON.stringify({ subject: 's', body: 'b' }) });
  return new MarketingService(new ComposeService(new OpenRouterService(fake)));
}

async function makeUser(consent: boolean, suppressed = false): Promise<{ id: string; email: string }> {
  const db = getDb();
  const e = email();
  const [u] = await db.insert(storefrontUsers).values({ companyId: COMPANY, email: e, kind: 'account' }).returning({ id: storefrontUsers.id });
  if (consent) {
    await db.insert(consentRecords).values({ companyId: COMPANY, userId: u!.id, consentType: 'general_marketing', granted: true, source: 't' });
  }
  if (suppressed) {
    await db.insert(suppressionList).values({ email: e, companyId: COMPANY, reason: 'bounce' });
  }
  return { id: u!.id, email: e };
}

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`ALTER TABLE consent_records DISABLE TRIGGER consent_records_no_delete`);
  const users = await db.select({ id: storefrontUsers.id, email: storefrontUsers.email }).from(storefrontUsers).where(like(storefrontUsers.email, 'mkt-%@example.test'));
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await db.delete(messageDrafts).where(inArray(messageDrafts.userId, ids));
    await db.delete(runOutPredictions).where(inArray(runOutPredictions.userId, ids));
    await db.delete(interestFlags).where(inArray(interestFlags.userId, ids));
    try {
      await db.delete(consentRecords).where(inArray(consentRecords.userId, ids));
    } catch {
      /* trigger */
    }
    await db.delete(suppressionList).where(inArray(suppressionList.email, users.map((u) => u.email!).filter(Boolean)));
    await db.delete(storefrontUsers).where(inArray(storefrontUsers.id, ids));
  }
  await db.execute(sql`ALTER TABLE consent_records ENABLE TRIGGER consent_records_no_delete`);
});

afterAll(async () => {
  await closeDatabase();
});

describe('cadence math', () => {
  it('regular history predicts a run-out; single is excluded; irregular is not "regular"', () => {
    const regular = [0, 30 * DAY, 60 * DAY, 90 * DAY];
    const p = predictRunOut(regular)!;
    expect(p.medianIntervalDays).toBe(30);
    expect(p.predictedRunOutMs).toBe(90 * DAY + 30 * DAY);
    expect(p.regular).toBe(true);

    expect(predictRunOut([0])).toBeNull(); // single purchase → excluded
    expect(predictRunOut([0, 5 * DAY])).toBeNull(); // below min-data floor (3)

    const irregular = [0, 2 * DAY, 60 * DAY, 63 * DAY];
    expect(predictRunOut(irregular)!.regular).toBe(false);
    expect(medianIntervalDays([0, 10 * DAY, 20 * DAY])).toBe(10);
  });
});

describe('segmentation gates', () => {
  it('composes only for consented, unsuppressed, uncapped offer-watchers', async () => {
    const db = getDb();
    const eligible = await makeUser(true);
    const noConsent = await makeUser(false);
    const suppressed = await makeUser(true, true);
    for (const u of [eligible, noConsent, suppressed]) {
      await db.insert(interestFlags).values({ companyId: COMPANY, userId: u.id, sku: 'MKT-SKU', flagType: 'offers' });
    }

    const counts = await marketerWith(1).runNightly(NOW);
    expect(counts.offer_watcher).toBe(1); // only the eligible user

    const drafts = await db.select().from(messageDrafts).where(inArray(messageDrafts.userId, [eligible.id, noConsent.id, suppressed.id]));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.userId).toBe(eligible.id);
  });

  it('composes at most once per night for a user in two segments', async () => {
    const db = getDb();
    const u = await makeUser(true);
    // In both run_out_due and offer_watcher.
    await db.insert(runOutPredictions).values({
      companyId: COMPANY,
      userId: u.id,
      sku: 'MKT-RO',
      medianIntervalDays: 30,
      purchaseCount: 3,
      lastPurchaseAt: new Date(NOW - 30 * DAY),
      predictedRunOutAt: new Date(NOW + 2 * DAY), // due within window
    });
    await db.insert(interestFlags).values({ companyId: COMPANY, userId: u.id, sku: 'MKT-RO', flagType: 'offers' });

    const counts = await marketerWith(2).runNightly(NOW);
    const total = counts.run_out_due + counts.offer_watcher + counts.subscription_upsell + counts.lapsed;
    expect(total).toBe(1); // deduped to a single message
    expect(counts.run_out_due).toBe(1); // higher priority wins

    const drafts = await db.select().from(messageDrafts).where(eq(messageDrafts.userId, u.id));
    expect(drafts).toHaveLength(1);
  });

  it('honours a disabled segment', async () => {
    const db = getDb();
    const u = await makeUser(true);
    await db.insert(interestFlags).values({ companyId: COMPANY, userId: u.id, sku: 'MKT-D', flagType: 'offers' });
    const counts = await marketerWith(0).runNightly(NOW, { enabledSegments: { offer_watcher: false } });
    expect(counts.offer_watcher).toBe(0);
  });
});
