/**
 * Compose/send pipeline tests (Prompt 9, SPEC §12). Real Postgres; FakeLlm +
 * FakeSendGrid (NODE_ENV=test).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import { getEnv } from '../../config/env.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import {
  storefrontUsers,
  consentRecords,
  suppressionList,
  messageDrafts,
  domainEvents,
} from '../../db/schema/index.js';
import { ComposeService } from './compose.service.js';
import { SendService } from './send.service.js';
import { TEMPLATES } from './templates.js';
import { unsubscribeToken } from './unsubscribe.js';
import { OpenRouterService } from '../../integrations/openrouter/openrouter.service.js';
import { FakeLlm } from '../../integrations/openrouter/openrouter.fake.js';
import { getSendGrid, FakeSendGrid } from '../../integrations/sendgrid/sendgrid.js';

const COMPANY = getSingletonCompanyId();
const send = new SendService();
let seq = 0;
const email = () => `msg-${Date.now()}-${++seq}@example.test`;

async function makeUser(marketingConsent: boolean): Promise<{ id: string; email: string }> {
  const db = getDb();
  const e = email();
  const [u] = await db
    .insert(storefrontUsers)
    .values({ companyId: COMPANY, email: e, kind: 'account' })
    .returning({ id: storefrontUsers.id });
  if (marketingConsent) {
    await db.insert(consentRecords).values({
      companyId: COMPANY,
      userId: u!.id,
      consentType: 'general_marketing',
      granted: true,
      source: 'test',
    });
  }
  return { id: u!.id, email: e };
}

async function makeDraft(
  userId: string,
  over: Partial<typeof messageDrafts.$inferInsert> = {},
): Promise<string> {
  const db = getDb();
  const [d] = await db
    .insert(messageDrafts)
    .values({
      companyId: COMPANY,
      userId,
      category: 'marketing',
      subject: 'Test',
      body: 'Body',
      status: 'approved',
      ...over,
    })
    .returning({ id: messageDrafts.id });
  return d!.id;
}

beforeEach(() => {
  (getSendGrid() as FakeSendGrid).reset();
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`ALTER TABLE consent_records DISABLE TRIGGER consent_records_no_delete`);
  const users = await db
    .select({ id: storefrontUsers.id, email: storefrontUsers.email })
    .from(storefrontUsers)
    .where(like(storefrontUsers.email, 'msg-%@example.test'));
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await db.delete(messageDrafts).where(inArray(messageDrafts.userId, ids));
    await db.delete(domainEvents).where(inArray(domainEvents.aggregateId, ids));
    try {
      await db.delete(consentRecords).where(inArray(consentRecords.userId, ids));
    } catch {
      /* trigger */
    }
    await db.delete(suppressionList).where(
      inArray(
        suppressionList.email,
        users.map((u) => u.email!).filter(Boolean),
      ),
    );
    await db.delete(storefrontUsers).where(inArray(storefrontUsers.id, ids));
  }
  await db.execute(sql`ALTER TABLE consent_records ENABLE TRIGGER consent_records_no_delete`);
});

afterAll(async () => {
  await closeDatabase();
});

describe('templates', () => {
  it('no compose template contains a percentage figure (§15.1a)', () => {
    for (const t of Object.values(TEMPLATES)) {
      expect(t.systemPrompt.includes('%')).toBe(false);
    }
  });
});

describe('compose', () => {
  it('writes a draft from a template and emits draft.created', async () => {
    const user = await makeUser(true);
    const fake = new FakeLlm().enqueue({
      content: JSON.stringify({ subject: 'Back in stock', body: 'Your PETG is back — save £4.00.' }),
    });
    const compose = new ComposeService(new OpenRouterService(fake));
    const { draftId } = await compose.compose({ userId: user.id, templateKey: 'back_in_stock', facts: { saving: 400 } });

    const db = getDb();
    const [draft] = await db.select().from(messageDrafts).where(eq(messageDrafts.id, draftId));
    expect(draft!.category).toBe('marketing');
    expect(draft!.subject).toBe('Back in stock');
    expect(draft!.groupKey).toMatch(/^back_in_stock:/);
    expect(draft!.expiresAt).not.toBeNull();
    const created = await db
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.aggregateId, draftId), eq(domainEvents.eventType, 'draft.created')));
    expect(created).toHaveLength(1);
  });
});

describe('send-time gate', () => {
  it('respects suppression added AFTER approval', async () => {
    const user = await makeUser(true);
    const draftId = await makeDraft(user.id);
    await getDb().insert(suppressionList).values({ email: user.email, companyId: COMPANY, reason: 'bounce' });
    const outcome = await send.send(draftId);
    expect(outcome).toMatchObject({ sent: false, reason: 'suppressed' });
    expect((getSendGrid() as FakeSendGrid).sent).toHaveLength(0);
  });

  it('parks a marketing message with no consent', async () => {
    const user = await makeUser(false); // no marketing consent
    const draftId = await makeDraft(user.id);
    const outcome = await send.send(draftId);
    expect(outcome).toMatchObject({ sent: false, reason: 'no_consent' });
  });

  it('parks the (N+1)th message when the frequency cap is hit', async () => {
    const env = getEnv();
    const user = await makeUser(true);
    // N already-sent marketing messages within the window.
    for (let i = 0; i < env.MARKETING_FREQ_CAP_COUNT; i++) {
      await makeDraft(user.id, { status: 'sent', resolvedAt: new Date() });
    }
    const draftId = await makeDraft(user.id);
    const outcome = await send.send(draftId);
    expect(outcome).toMatchObject({ sent: false, reason: 'frequency_cap' });
    // The parked reason is queryable.
    const [d] = await getDb().select().from(messageDrafts).where(eq(messageDrafts.id, draftId));
    expect(d!.editorNotes).toBe('parked:frequency_cap');
  });

  it('never sends an expired draft', async () => {
    const user = await makeUser(true);
    const draftId = await makeDraft(user.id, { expiresAt: new Date(Date.now() - 1000) });
    const outcome = await send.send(draftId);
    expect(outcome).toMatchObject({ sent: false, reason: 'expired' });
    const [d] = await getDb().select().from(messageDrafts).where(eq(messageDrafts.id, draftId));
    expect(d!.rejectReason).toBe('expired');
  });

  it('is idempotent — a retry never double-sends', async () => {
    const user = await makeUser(true);
    const draftId = await makeDraft(user.id, { category: 'transactional' });
    const a = await send.send(draftId);
    const b = await send.send(draftId);
    expect(a).toMatchObject({ sent: true });
    expect(b).toMatchObject({ sent: true });
    expect((getSendGrid() as FakeSendGrid).sent).toHaveLength(1);
    const sentEvents = await getDb()
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.aggregateId, draftId), eq(domainEvents.eventType, 'message.sent')));
    expect(sentEvents).toHaveLength(1);
  });
});

describe('webhook + unsubscribe', () => {
  let app: FastifyInstance;

  it('rejects a bad signature and processes a valid bounce/unsubscribe', async () => {
    app = await buildApp();
    await app.ready();
    const user = await makeUser(true);
    const payload = [{ email: user.email, event: 'unsubscribe' }];
    const raw = JSON.stringify(payload);
    const sig = createHmac('sha256', getEnv().SENDGRID_WEBHOOK_KEY).update(raw).digest('hex');

    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/sendgrid',
      headers: { 'x-webhook-signature': 'nope' },
      payload,
    });
    expect(bad.statusCode).toBe(401);

    const good = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/sendgrid',
      headers: { 'x-webhook-signature': sig },
      payload,
    });
    expect(good.statusCode).toBe(200);

    // Suppressed + consent revoked.
    const db = getDb();
    const [sup] = await db.select().from(suppressionList).where(eq(suppressionList.email, user.email));
    expect(sup!.reason).toBe('unsubscribe');
    const consents = await db
      .select()
      .from(consentRecords)
      .where(and(eq(consentRecords.userId, user.id), eq(consentRecords.consentType, 'general_marketing')));
    expect(consents.some((c) => !c.granted)).toBe(true);
    await app.close();
  });

  it('a signed unsubscribe link revokes consent', async () => {
    app = await buildApp();
    await app.ready();
    const user = await makeUser(true);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/unsubscribe?u=${user.id}&t=${unsubscribeToken(user.id)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/unsubscribed/i);
    const consents = await getDb()
      .select()
      .from(consentRecords)
      .where(and(eq(consentRecords.userId, user.id), eq(consentRecords.consentType, 'general_marketing')));
    expect(consents.some((c) => !c.granted)).toBe(true);
    await app.close();
  });
});
