/**
 * Approval-queue tests (Prompt 10, SPEC §17). Real Postgres at DATABASE_URL.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import {
  storefrontUsers,
  messageDrafts,
  domainEvents,
  agentConfig,
} from '../../db/schema/index.js';
import { ApprovalQueueService, IllegalTransitionError, selectSpotChecks } from './approval.service.js';
import { ComposeService } from './../messaging/compose.service.js';
import { OpenRouterService } from '../../integrations/openrouter/openrouter.service.js';
import { FakeLlm } from '../../integrations/openrouter/openrouter.fake.js';

const COMPANY = getSingletonCompanyId();
const queue = new ApprovalQueueService();
let seq = 0;

async function makeUser(): Promise<string> {
  const [u] = await getDb()
    .insert(storefrontUsers)
    .values({ companyId: COMPANY, email: `apr-${Date.now()}-${++seq}@example.test`, kind: 'account' })
    .returning({ id: storefrontUsers.id });
  return u!.id;
}

async function makeDraft(userId: string, over: Partial<typeof messageDrafts.$inferInsert> = {}): Promise<string> {
  const [d] = await getDb()
    .insert(messageDrafts)
    .values({
      companyId: COMPANY,
      userId,
      category: 'marketing',
      subject: 'S',
      body: 'B',
      status: 'pending',
      groupKey: 'back_in_stock:trig',
      ...over,
    })
    .returning({ id: messageDrafts.id });
  return d!.id;
}

async function events(draftId: string, type: string) {
  return getDb()
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.aggregateId, draftId), eq(domainEvents.eventType, type)));
}

afterEach(async () => {
  const db = getDb();
  const users = await db
    .select({ id: storefrontUsers.id })
    .from(storefrontUsers)
    .where(like(storefrontUsers.email, 'apr-%@example.test'));
  const ids = users.map((u) => u.id);
  if (ids.length) {
    const drafts = await db.select({ id: messageDrafts.id }).from(messageDrafts).where(inArray(messageDrafts.userId, ids));
    const dids = drafts.map((d) => d.id);
    if (dids.length) await db.delete(domainEvents).where(inArray(domainEvents.aggregateId, dids));
    await db.delete(messageDrafts).where(inArray(messageDrafts.userId, ids));
    await db.delete(storefrontUsers).where(inArray(storefrontUsers.id, ids));
  }
  await db.delete(agentConfig).where(eq(agentConfig.eventType, 'back_in_stock'));
});

afterAll(async () => {
  await closeDatabase();
});

describe('selectSpotChecks', () => {
  it('is deterministic for a fixed seed and bounded by k', () => {
    const members = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = selectSpotChecks(members, 3, 42);
    const b = selectSpotChecks(members, 3, 42);
    expect(a).toEqual(b);
    expect(a).toHaveLength(3);
    expect(selectSpotChecks(members, 3, 99)).not.toEqual(a); // different seed → different pick
  });
});

describe('priority ordering (§17.3)', () => {
  it('orders ETA-slip notices above escalations, fanouts, and nightly marketing', async () => {
    const u = await makeUser();
    await makeDraft(u, { groupKey: 'run_out_reminder:x', category: 'marketing' });
    await makeDraft(u, { groupKey: 'eta_slip:x', category: 'transactional' });
    await makeDraft(u, { groupKey: 'back_in_stock:x', category: 'marketing' });
    const items = await queue.listQueue();
    const ranks = items.map((i) => i.groupKey?.split(':')[0]);
    expect(ranks[0]).toBe('eta_slip'); // most urgent first
    expect(ranks.indexOf('back_in_stock')).toBeLessThan(ranks.indexOf('run_out_reminder'));
  });
});

describe('approve / edit / reject state machine', () => {
  it('approve emits draft.approved; a second action is illegal', async () => {
    const u = await makeUser();
    const id = await makeDraft(u);
    await queue.approve(id);
    expect(await events(id, 'draft.approved')).toHaveLength(1);
    await expect(queue.approve(id)).rejects.toBeInstanceOf(IllegalTransitionError);
    await expect(queue.reject(id, 'other')).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it('edit-then-approve stores the original body', async () => {
    const u = await makeUser();
    const id = await makeDraft(u, { body: 'original' });
    await queue.editThenApprove(id, 'New subject', 'edited body');
    const [d] = await getDb().select().from(messageDrafts).where(eq(messageDrafts.id, id));
    expect(d!.bodyOriginal).toBe('original');
    expect(d!.body).toBe('edited body');
    expect(d!.status).toBe('approved');
  });

  it('reject requires a reason and records it', async () => {
    const u = await makeUser();
    const id = await makeDraft(u);
    await queue.reject(id, 'wrong_facts');
    const [d] = await getDb().select().from(messageDrafts).where(eq(messageDrafts.id, id));
    expect(d!.status).toBe('rejected');
    expect(d!.rejectReason).toBe('wrong_facts');
  });
});

describe('group approve', () => {
  it('approves exactly the group members', async () => {
    const u = await makeUser();
    const gk = 'back_in_stock:grp1';
    const inGroup = [await makeDraft(u, { groupKey: gk }), await makeDraft(u, { groupKey: gk })];
    const other = await makeDraft(u, { groupKey: 'back_in_stock:other' });
    const n = await queue.approveGroup(gk);
    expect(n).toBe(2);
    for (const id of inGroup) {
      const [d] = await getDb().select().from(messageDrafts).where(eq(messageDrafts.id, id));
      expect(d!.status).toBe('approved');
    }
    const [o] = await getDb().select().from(messageDrafts).where(eq(messageDrafts.id, other));
    expect(o!.status).toBe('pending'); // untouched
  });
});

describe('graduation + auto-send toggle', () => {
  it('computes the approved-unedited rate and the toggle flips compose behaviour', async () => {
    const u = await makeUser();
    // 3 approved-unedited, 1 edited → 75%.
    await makeDraft(u, { status: 'approved', resolvedAt: new Date() });
    await makeDraft(u, { status: 'approved', resolvedAt: new Date() });
    await makeDraft(u, { status: 'sent', resolvedAt: new Date() });
    await makeDraft(u, { status: 'approved', bodyOriginal: 'was', resolvedAt: new Date() });
    const stats = await queue.graduationStats('back_in_stock');
    expect(stats.sampleSize).toBe(4);
    expect(stats.approvedUneditedRate).toBeCloseTo(0.75, 5);

    // Turn auto-send on → the next compose emits an auto_approved draft.
    await queue.setAutoSend('back_in_stock', true);
    const fake = new FakeLlm().enqueue({ content: JSON.stringify({ subject: 'x', body: 'y' }) });
    const compose = new ComposeService(new OpenRouterService(fake));
    const { draftId } = await compose.compose({ userId: u, templateKey: 'back_in_stock' });
    const [d] = await getDb().select().from(messageDrafts).where(eq(messageDrafts.id, draftId));
    expect(d!.status).toBe('auto_approved');
    // and it emitted draft.approved for the auto path
    expect(await events(draftId, 'draft.approved')).toHaveLength(1);
  });
});

describe('expired-draft sweep (§17.7)', () => {
  it('expires overdue pending/approved drafts', async () => {
    const u = await makeUser();
    const past = await makeDraft(u, { expiresAt: new Date(Date.now() - 1000) });
    const future = await makeDraft(u, { expiresAt: new Date(Date.now() + 3_600_000) });
    const n = await queue.expiredDraftSweep();
    expect(n).toBeGreaterThanOrEqual(1);
    const [p] = await getDb().select().from(messageDrafts).where(eq(messageDrafts.id, past));
    expect(p!.status).toBe('failed');
    expect(p!.rejectReason).toBe('expired');
    const [f] = await getDb().select().from(messageDrafts).where(eq(messageDrafts.id, future));
    expect(f!.status).toBe('pending');
  });
});
