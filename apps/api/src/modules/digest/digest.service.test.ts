/**
 * Digest + health tests (Prompt 15, SPEC §6, §17.9).
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import {
  storefrontUsers,
  messageDrafts,
  escalations,
  preorderOrders,
  llmLog,
} from '../../db/schema/index.js';
import { DigestService } from './digest.service.js';
import { checkHealth } from '../health/health.routes.js';

const COMPANY = getSingletonCompanyId();
const NOW = Date.now();
const digest = new DigestService();
let seq = 0;

afterEach(async () => {
  const db = getDb();
  const users = await db.select({ id: storefrontUsers.id }).from(storefrontUsers).where(like(storefrontUsers.email, 'dig-%@example.test'));
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await db.delete(messageDrafts).where(inArray(messageDrafts.userId, ids));
    await db.delete(preorderOrders).where(inArray(preorderOrders.userId, ids));
    await db.delete(storefrontUsers).where(inArray(storefrontUsers.id, ids));
  }
  await db.delete(escalations).where(eq(escalations.summary, 'DIG-ESC'));
  await db.delete(llmLog).where(eq(llmLog.model, 'dig-seed'));
});

afterAll(async () => {
  await closeDatabase();
});

describe('checkHealth', () => {
  it('reports the DB up', async () => {
    const h = await checkHealth();
    expect(h.checks.db).toBe(true);
    expect(h.status).toBe('ok');
  });
});

describe('buildDigest', () => {
  it('assembles queue counts, escalations, payment window, and LLM spend', async () => {
    const db = getDb();
    const [u] = await db.insert(storefrontUsers).values({ companyId: COMPANY, email: `dig-${++seq}@example.test`, kind: 'account' }).returning({ id: storefrontUsers.id });
    await db.insert(messageDrafts).values([
      { companyId: COMPANY, userId: u!.id, category: 'transactional', subject: 's', body: 'b', status: 'pending', groupKey: 'eta_slip:x' },
      { companyId: COMPANY, userId: u!.id, category: 'marketing', subject: 's', body: 'b', status: 'pending', groupKey: 'back_in_stock:y' },
      { companyId: COMPANY, userId: u!.id, category: 'marketing', subject: 's', body: 'b', status: 'auto_approved', groupKey: 'z:1' },
      { companyId: COMPANY, userId: u!.id, category: 'marketing', subject: 's', body: 'b', status: 'failed', rejectReason: 'expired', groupKey: 'z:2' },
      { companyId: COMPANY, userId: u!.id, category: 'marketing', subject: 's', body: 'b', status: 'pending', groupKey: `marketing:offer_watcher:${new Date(NOW).toISOString().slice(0, 10)}`, createdAt: new Date(NOW) },
    ]);
    await db.insert(escalations).values({ companyId: COMPANY, reason: 'other', summary: 'DIG-ESC', status: 'open' });
    await db.insert(preorderOrders).values({ companyId: COMPANY, userId: u!.id, status: 'awaiting_payment', paymentMethod: 'manual_transfer', paymentReference: `DIG-${++seq}`, totalPence: 1000 });
    await db.insert(llmLog).values({ companyId: COMPANY, purpose: 'chat', model: 'dig-seed', requestJson: {}, costMicroUsd: 12345, createdAt: new Date(NOW) });

    const d = await digest.buildDigest(NOW);
    expect(d.queue.pending).toBeGreaterThanOrEqual(3);
    expect(d.queue.byType.eta_slip).toBeGreaterThanOrEqual(1);
    expect(d.autoSent).toBeGreaterThanOrEqual(1);
    expect(d.expiredDrafts).toBeGreaterThanOrEqual(1);
    expect(d.openEscalations).toBeGreaterThanOrEqual(1);
    expect(d.paymentWindow.awaiting).toBeGreaterThanOrEqual(1);
    expect(d.llmSpend.spentMicroUsd).toBeGreaterThanOrEqual(12345);
    expect(d.marketingSegments.offer_watcher).toBeGreaterThanOrEqual(1);
    expect(typeof d.jobFailures).toBe('number');
  });
});
