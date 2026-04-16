import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, and, isNull, sql } from 'drizzle-orm';
import * as schema from '../db/schema/index.js';
import { LucaClient } from '../integrations/luca/luca-client.js';
import { LUCA_ACCOUNTS } from '../integrations/luca/luca-account-map.js';

/**
 * Opening Balances Script
 *
 * After data migration, this script calculates opening balances from the
 * imported transactional data and posts them to Luca via gl_post_opening_balances.
 *
 * Run: COMPANY_ID=... PG_URL=... npx tsx src/migration/opening-balances.ts
 *
 * Calculates:
 *   1. Total outstanding AR (unpaid customer invoices) → Debit 1100
 *   2. Total outstanding AP (unpaid supplier invoices) → Credit 2000
 *   3. Total stock value (IN_STOCK items) → Debit 1150
 *   4. Balancing entry to Retained Earnings (3100)
 */
async function main() {
  const companyId = process.env.COMPANY_ID;
  const pgUrl = process.env.PG_URL ?? 'postgresql://smmta:smmta@localhost:5432/smmta_next';
  const effectiveDate = process.env.EFFECTIVE_DATE ?? new Date().toISOString().slice(0, 10);

  if (!companyId) {
    console.error('COMPANY_ID environment variable required');
    process.exit(1);
  }

  console.log('=== Opening Balances for Luca GL ===\n');
  console.log(`Company: ${companyId}`);
  console.log(`Effective date: ${effectiveDate}\n`);

  const pool = new pg.Pool({ connectionString: pgUrl });
  const db = drizzle(pool, { schema });
  const luca = new LucaClient();

  // 1. Calculate outstanding AR (customer invoices)
  const arResult = await db
    .select({
      total: sql<string>`COALESCE(SUM(CAST(amount_outstanding AS NUMERIC)), 0)`,
    })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.companyId, companyId),
        isNull(schema.invoices.deletedAt),
      ),
    );
  const totalAR = parseFloat(arResult[0]?.total ?? '0');
  console.log(`Accounts Receivable (1100): £${totalAR.toFixed(2)}`);

  // 2. Calculate outstanding AP (supplier invoices)
  const apResult = await db
    .select({
      total: sql<string>`COALESCE(SUM(CAST(amount_outstanding AS NUMERIC)), 0)`,
    })
    .from(schema.supplierInvoices)
    .where(
      and(
        eq(schema.supplierInvoices.companyId, companyId),
        isNull(schema.supplierInvoices.deletedAt),
      ),
    );
  const totalAP = parseFloat(apResult[0]?.total ?? '0');
  console.log(`Accounts Payable (2000): £${totalAP.toFixed(2)}`);

  // 3. Calculate total stock value
  const stockResult = await db
    .select({
      total: sql<string>`COALESCE(SUM(CAST(value AS NUMERIC) * quantity), 0)`,
    })
    .from(schema.stockItems)
    .where(
      and(
        eq(schema.stockItems.companyId, companyId),
        eq(schema.stockItems.status, 'IN_STOCK'),
        isNull(schema.stockItems.deletedAt),
      ),
    );
  const totalStock = parseFloat(stockResult[0]?.total ?? '0');
  console.log(`Stock (1150): £${totalStock.toFixed(2)}`);

  // 4. Calculate balancing entry (Retained Earnings)
  // Assets (AR + Stock) - Liabilities (AP) = Equity (Retained Earnings)
  const retainedEarnings = totalAR + totalStock - totalAP;
  console.log(`Retained Earnings (3100): £${retainedEarnings.toFixed(2)}`);

  // Build opening balances array for Luca
  const balances: Array<string> = [];

  if (totalAR > 0) {
    balances.push(JSON.stringify({
      account_code: LUCA_ACCOUNTS.TRADE_DEBTORS,
      debit: totalAR.toFixed(2),
    }));
  }
  if (totalStock > 0) {
    balances.push(JSON.stringify({
      account_code: LUCA_ACCOUNTS.STOCK,
      debit: totalStock.toFixed(2),
    }));
  }
  if (totalAP > 0) {
    balances.push(JSON.stringify({
      account_code: LUCA_ACCOUNTS.TRADE_CREDITORS,
      credit: totalAP.toFixed(2),
    }));
  }
  if (retainedEarnings !== 0) {
    if (retainedEarnings > 0) {
      balances.push(JSON.stringify({
        account_code: LUCA_ACCOUNTS.RETAINED_EARNINGS,
        credit: retainedEarnings.toFixed(2),
      }));
    } else {
      balances.push(JSON.stringify({
        account_code: LUCA_ACCOUNTS.RETAINED_EARNINGS,
        debit: Math.abs(retainedEarnings).toFixed(2),
      }));
    }
  }

  if (balances.length === 0) {
    console.log('\nNo balances to post — all zeroes.');
    await pool.end();
    return;
  }

  console.log(`\nPosting ${balances.length} opening balance lines to Luca...`);

  if (process.env.DRY_RUN === 'true') {
    console.log('DRY RUN — not posting. Balances would be:');
    balances.forEach((b) => console.log(`  ${b}`));
  } else {
    try {
      // Use Luca's gl_post_opening_balances equivalent via the REST API
      const result = await luca.postTransaction({
        transaction_type: 'MANUAL_JOURNAL',
        date: effectiveDate,
        period_id: effectiveDate.slice(0, 7),
        description: 'Opening balances — migration from SMMTA',
        reference: 'OPENING-BAL',
        lines: balances.map((b) => {
          const parsed = JSON.parse(b);
          return {
            account_code: parsed.account_code,
            amount: parsed.debit ?? parsed.credit,
            type: parsed.debit ? 'DEBIT' as const : 'CREDIT' as const,
          };
        }),
        idempotency_key: `OPENING-BAL-${companyId}`,
        submitted_by: 'smmta-next-migration',
      });
      console.log('✓ Opening balances posted successfully');
      console.log(`  Luca transaction ID: ${result.transaction_id}`);
    } catch (err) {
      console.error('✗ Failed to post opening balances:', (err as Error).message);
    }
  }

  await pool.end();
  console.log('\n=== Opening balances complete ===');
}

main().catch(console.error);
