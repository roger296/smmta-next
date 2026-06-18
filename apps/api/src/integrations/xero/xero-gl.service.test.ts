/**
 * XeroGLService (P5, spec §A8). Real Postgres. Runs in dry-run by default
 * (XERO_DRY_RUN defaults true), so nothing hits the network.
 *
 * Proves: a dry-run post logs a BALANCED journal and sends nothing; a re-post
 * with the same idempotency key is a no-op; the account map resolves every
 * logical role; and an unconfigured (no-credential) non-dry-run post degrades
 * to a logged dry-run rather than throwing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { glPostingLog } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { resetEnvForTests } from '../../config/env.js';
import { XeroGLService } from './xero-gl.service.js';
import {
  XERO_ACCOUNT_ROLES,
  resolveXeroAccount,
} from './xero-account-map.js';

const COMPANY = getSingletonCompanyId();
const svc = new XeroGLService();
const KEYS = ['GRN-p5grn-v1', 'SADJ-p5adj-v1', 'GRN-p5uncfg-v1'];

async function cleanup(): Promise<void> {
  const db = getDb();
  for (const k of KEYS) {
    await db.delete(glPostingLog).where(eq(glPostingLog.idempotencyKey, k));
  }
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await closeDatabase();
});

function netOfLines(payload: unknown): number {
  const lines = (payload as { journalLines: Array<{ lineAmount: number }> }).journalLines;
  return Math.round(lines.reduce((s, l) => s + l.lineAmount, 0) * 100) / 100;
}

describe('XeroGLService dry-run', () => {
  it('logs a balanced journal and sends nothing', async () => {
    const db = getDb();
    const ret = await svc.postGoodsReceivedNote(db, {
      companyId: COMPANY,
      grnId: 'p5grn',
      grnNumber: 'GRN-P5',
      poNumber: 'PO-P5',
      bookedInDate: new Date('2026-06-18'),
      stockValue: 100,
      deliveryCharge: 10,
      isService: false,
    });
    expect(ret).toBe('DRYRUN');
    const row = await db.query.glPostingLog.findFirst({
      where: eq(glPostingLog.idempotencyKey, 'GRN-p5grn-v1'),
    });
    expect(row).toBeTruthy();
    expect(row!.status).toBe('SUCCESS');
    expect(row!.lucaTransactionId).toBe('DRYRUN');
    // Journal recorded in request_payload, lines net to zero.
    expect(netOfLines(row!.requestPayload)).toBe(0);
  });

  it('is idempotent — re-posting the same key is a no-op', async () => {
    const db = getDb();
    await svc.postStockAdjustment(db, {
      companyId: COMPANY,
      adjustmentId: 'p5adj',
      adjustmentDate: new Date('2026-06-18'),
      stockValue: 25,
      type: 'REMOVE',
      productName: 'Sugar',
    });
    await svc.postStockAdjustment(db, {
      companyId: COMPANY,
      adjustmentId: 'p5adj',
      adjustmentDate: new Date('2026-06-18'),
      stockValue: 25,
      type: 'REMOVE',
      productName: 'Sugar',
    });
    const rows = await db
      .select({ id: glPostingLog.id })
      .from(glPostingLog)
      .where(eq(glPostingLog.idempotencyKey, 'SADJ-p5adj-v1'));
    expect(rows).toHaveLength(1); // single ledger row despite two posts
  });
});

describe('Xero account map', () => {
  it('resolves every logical role to an account', async () => {
    for (const role of XERO_ACCOUNT_ROLES) {
      const acct = await resolveXeroAccount(role, COMPANY);
      expect(acct.code).toMatch(/^\d{3,}$/);
      expect(typeof acct.taxType).toBe('string');
    }
  });
});

describe('unconfigured degrade', () => {
  afterEach(() => {
    delete process.env.XERO_DRY_RUN;
    resetEnvForTests();
  });

  it('degrades to a logged dry-run (does not throw) when no credential exists', async () => {
    // Force live mode but leave XERO_CLIENT_ID unset → no connection → degrade.
    process.env.XERO_DRY_RUN = 'false';
    resetEnvForTests();
    const db = getDb();
    const ret = await svc.postGoodsReceivedNote(db, {
      companyId: COMPANY,
      grnId: 'p5uncfg',
      grnNumber: 'GRN-UNCFG',
      poNumber: 'PO-UNCFG',
      bookedInDate: new Date('2026-06-18'),
      stockValue: 50,
      deliveryCharge: 0,
      isService: false,
    });
    expect(ret).toBe('DRYRUN-UNCONFIGURED');
    const row = await db.query.glPostingLog.findFirst({
      where: eq(glPostingLog.idempotencyKey, 'GRN-p5uncfg-v1'),
    });
    expect(row!.status).toBe('SUCCESS');
  });
});
