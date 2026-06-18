/**
 * XeroGLService — posts the stock-related GL events to Xero, keeping the
 * LucaGLService method surface so it's a drop-in behind the GL_PROVIDER switch
 * (spec §A2/§A8). Adds postConsumptionCOGS + postWastage for the head-baker /
 * daily-sweep flows (P17).
 *
 * Every post writes a PENDING `gl_posting_log` row keyed by the deterministic
 * idempotency key, then resolves to SUCCESS / FAILED. It is:
 *   - **idempotent** — a key that already posted SUCCESS is a no-op;
 *   - **dry-run by default** (XERO_DRY_RUN) — records the intended journal in
 *     `request_payload` and sends nothing;
 *   - **fail-safe** — a missing/unconfigured Xero connection degrades to a
 *     logged dry-run rather than throwing.
 *
 * Journals are balanced: line amounts are signed (debit > 0, credit < 0) and
 * always net to zero.
 */
import { eq } from 'drizzle-orm';
import { glPostingLog } from '../../db/schema/index.js';
import { glIdempotencyKey } from '../../shared/utils/idempotency.js';
import { getEnv } from '../../config/env.js';
import { XeroClient } from './xero-client.js';
import { resolveXeroAccount } from './xero-account-map.js';
import type { XeroJournalLine, XeroManualJournal } from './xero-types.js';

// Loose shape (mirrors the Luca service's DbTx) so both the pooled db and a
// drizzle transaction satisfy it. `any` params keep method variance bivariant.
interface GLDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert: (table: any) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update: (table: any) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export class XeroGLService {
  // ── A. Goods received note — Dr Stock / Cr GRNI accrual(s) ──────────
  async postGoodsReceivedNote(
    db: GLDb,
    params: {
      companyId: string;
      grnId: string;
      grnNumber: string;
      poNumber: string;
      bookedInDate: Date;
      stockValue: number;
      deliveryCharge: number;
      isService: boolean;
      currencyCode?: string;
    },
  ): Promise<string> {
    const total = round2(params.stockValue + params.deliveryCharge);
    const stock = await resolveXeroAccount('STOCK', params.companyId, db);
    const grni = await resolveXeroAccount(
      params.isService ? 'SERVICE_GRNI_ACCRUAL' : 'GRNI_ACCRUAL',
      params.companyId,
      db,
    );
    const lines: XeroJournalLine[] = [
      { accountCode: stock.code, lineAmount: total, taxType: stock.taxType },
      { accountCode: grni.code, lineAmount: -round2(params.stockValue), taxType: grni.taxType },
    ];
    if (params.deliveryCharge > 0) {
      const delivery = await resolveXeroAccount('DELIVERY_GRNI_ACCRUAL', params.companyId, db);
      lines.push({
        accountCode: delivery.code,
        lineAmount: -round2(params.deliveryCharge),
        taxType: delivery.taxType,
      });
    }
    return this.post(db, {
      companyId: params.companyId,
      entityType: 'GRN',
      entityId: params.grnId,
      idempotencyKey: glIdempotencyKey('GRN', params.grnId),
      narration: `GRN ${params.grnNumber} — book-in for PO ${params.poNumber}`,
      date: params.bookedInDate,
      amount: total,
      currencyCode: params.currencyCode,
      lines,
    });
  }

  // ── B. Stock adjustment — ADD: Dr Stock / Cr write-back; REMOVE inverse ─
  async postStockAdjustment(
    db: GLDb,
    params: {
      companyId: string;
      adjustmentId: string;
      adjustmentDate: Date;
      stockValue: number;
      type: 'ADD' | 'REMOVE';
      productName: string;
      currencyCode?: string;
    },
  ): Promise<string> {
    if (params.stockValue <= 0) return '';
    const value = round2(params.stockValue);
    const stock = await resolveXeroAccount('STOCK', params.companyId, db);
    const counter = await resolveXeroAccount(
      params.type === 'ADD' ? 'STOCK_WRITE_BACK' : 'STOCK_WRITE_OFFS',
      params.companyId,
      db,
    );
    const lines: XeroJournalLine[] =
      params.type === 'ADD'
        ? [
            { accountCode: stock.code, lineAmount: value, taxType: stock.taxType },
            { accountCode: counter.code, lineAmount: -value, taxType: counter.taxType },
          ]
        : [
            { accountCode: counter.code, lineAmount: value, taxType: counter.taxType },
            { accountCode: stock.code, lineAmount: -value, taxType: stock.taxType },
          ];
    return this.post(db, {
      companyId: params.companyId,
      entityType: 'STOCK_ADJUSTMENT',
      entityId: params.adjustmentId,
      idempotencyKey: glIdempotencyKey('SADJ', params.adjustmentId),
      narration: `Stock adjustment — ${params.type} ${params.productName}`,
      date: params.adjustmentDate,
      amount: value,
      currencyCode: params.currencyCode,
      lines,
    });
  }

  // ── C. Consumption COGS — Dr COGS / Cr Stock (head-baker / daily sweep) ─
  async postConsumptionCOGS(
    db: GLDb,
    params: { companyId: string; sourceKey: string; date: Date; amount: number; label: string; currencyCode?: string },
  ): Promise<string> {
    if (params.amount <= 0) return '';
    const value = round2(params.amount);
    const cogs = await resolveXeroAccount('CONSUMPTION_COGS', params.companyId, db);
    const stock = await resolveXeroAccount('STOCK', params.companyId, db);
    return this.post(db, {
      companyId: params.companyId,
      entityType: 'CONSUMPTION_COGS',
      entityId: params.sourceKey,
      idempotencyKey: glIdempotencyKey('CCOGS', params.sourceKey),
      narration: `Consumption COGS — ${params.label}`,
      date: params.date,
      amount: value,
      currencyCode: params.currencyCode,
      lines: [
        { accountCode: cogs.code, lineAmount: value, taxType: cogs.taxType },
        { accountCode: stock.code, lineAmount: -value, taxType: stock.taxType },
      ],
    });
  }

  // ── D. Wastage — Dr wastage write-off / Cr Stock ───────────────────
  async postWastage(
    db: GLDb,
    params: { companyId: string; sourceKey: string; date: Date; amount: number; label: string; currencyCode?: string },
  ): Promise<string> {
    if (params.amount <= 0) return '';
    const value = round2(params.amount);
    const waste = await resolveXeroAccount('WASTAGE_WRITE_OFF', params.companyId, db);
    const stock = await resolveXeroAccount('STOCK', params.companyId, db);
    return this.post(db, {
      companyId: params.companyId,
      entityType: 'WASTAGE',
      entityId: params.sourceKey,
      idempotencyKey: glIdempotencyKey('WASTE', params.sourceKey),
      narration: `Wastage — ${params.label}`,
      date: params.date,
      amount: value,
      currencyCode: params.currencyCode,
      lines: [
        { accountCode: waste.code, lineAmount: value, taxType: waste.taxType },
        { accountCode: stock.code, lineAmount: -value, taxType: stock.taxType },
      ],
    });
  }

  // ── Private: build journal, log, and (unless dry-run) post ─────────
  private async post(
    db: GLDb,
    opts: {
      companyId: string;
      entityType: string;
      entityId: string;
      idempotencyKey: string;
      narration: string;
      date: Date;
      amount: number;
      currencyCode?: string;
      lines: XeroJournalLine[];
    },
  ): Promise<string> {
    // Defensive balance check — lines must net to zero.
    const net = round2(opts.lines.reduce((s, l) => s + l.lineAmount, 0));
    if (net !== 0) {
      throw new Error(`Unbalanced Xero journal for ${opts.idempotencyKey}: net ${net}`);
    }

    // Idempotency — a key already posted SUCCESS is a no-op.
    const existing = await db.query.glPostingLog.findFirst({
      where: eq(glPostingLog.idempotencyKey, opts.idempotencyKey),
    });
    if (existing && existing.status === 'SUCCESS') {
      return existing.lucaTransactionId ?? '';
    }

    const journal: XeroManualJournal = {
      narration: opts.narration,
      date: opts.date.toISOString().slice(0, 10),
      status: 'DRAFT',
      currencyCode: opts.currencyCode ?? 'GBP',
      journalLines: opts.lines,
    };

    const env = getEnv();

    // If a row already exists (e.g. a prior FAILED attempt), reuse it; else insert PENDING.
    let logId: string;
    if (existing) {
      logId = existing.id;
      await db
        .update(glPostingLog)
        .set({ status: 'PENDING', requestPayload: journal, updatedAt: new Date() })
        .where(eq(glPostingLog.id, existing.id));
    } else {
      const inserted = (await db
        .insert(glPostingLog)
        .values({
          companyId: opts.companyId,
          entityType: opts.entityType,
          entityId: opts.entityId,
          lucaTransactionType: 'MANUAL_JOURNAL',
          idempotencyKey: opts.idempotencyKey,
          amount: opts.amount.toString(),
          description: opts.narration,
          status: 'PENDING',
          requestPayload: journal,
        })
        .returning()) as Array<{ id: string }>;
      logId = inserted[0]!.id;
    }

    // Dry-run (default) OR no live connection → log only, never send.
    const client = env.XERO_DRY_RUN ? null : await XeroClient.fromConnection(opts.companyId);
    if (env.XERO_DRY_RUN || !client) {
      const marker = env.XERO_DRY_RUN ? 'DRYRUN' : 'DRYRUN-UNCONFIGURED';
      await db
        .update(glPostingLog)
        .set({
          status: 'SUCCESS',
          lucaTransactionId: marker,
          responsePayload: { dryRun: true, reason: marker },
          updatedAt: new Date(),
        })
        .where(eq(glPostingLog.id, logId));
      return marker;
    }

    try {
      const result = await client.postManualJournal(journal);
      await db
        .update(glPostingLog)
        .set({
          status: 'SUCCESS',
          lucaTransactionId: result.manualJournalId,
          responsePayload: result as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        })
        .where(eq(glPostingLog.id, logId));
      return result.manualJournalId;
    } catch (err) {
      await db
        .update(glPostingLog)
        .set({
          status: 'FAILED',
          errorMessage: (err as Error).message,
          updatedAt: new Date(),
        })
        .where(eq(glPostingLog.id, logId));
      throw err;
    }
  }
}
