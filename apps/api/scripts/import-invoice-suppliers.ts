/**
 * Create the supplier records BumbleBee's invoices prove exist.
 *
 *   npx tsx apps/api/scripts/import-invoice-suppliers.ts --dry-run
 *   npx tsx apps/api/scripts/import-invoice-suppliers.ts
 *
 * Reads the CSVs written by `extract-invoice-suppliers.py` — never BumbleBee
 * directly, so what gets imported is exactly what was reviewed.
 *
 * Rebecca's workbook named 29 suppliers. The invoices name 86. The 43 in
 * between account for around GBP119k of stock spend and have no row to raise a
 * purchase order against.
 *
 * NEVER OVERWRITES. An invoice knows less about a supplier than the operator
 * who set one up by hand: it has a name and nothing else. So an existing row is
 * only ever gap-filled — a blank slug or type gets one, anything already
 * written is left exactly as it is. The only rows this creates from scratch are
 * ones that did not exist at all.
 *
 * NOT ORDERABLE. An invoice proves a supplier exists and what was bought; it
 * carries no email, lead time or credit terms. Every supplier created here
 * therefore lands without a way to order from it, and a PO cannot be sent until
 * someone fills that in. The run ends by listing them ranked by spend, so the
 * gap is a work list rather than a surprise at the point of ordering.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { suppliers } from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';
import { splitCsvLine } from './import-supplier-catalogue.js';

const DATA_DIR = join(import.meta.dirname, '..', 'data', 'invoice-suppliers');

export interface InvoiceSupplierRow {
  name: string;
  slug: string;
  type: string;
  spendGbp: number;
  invoiceCount: number;
}

export function readSupplierCsv(text: string): InvoiceSupplierRow[] {
  const lines = text.replace(/^﻿/, '').trim().split(/\r?\n/);
  const header = splitCsvLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const g = (k: string) => (cells[header.indexOf(k)] ?? '').trim();
    return {
      name: g('name'),
      slug: g('slug'),
      type: g('type'),
      spendGbp: Number(g('spend_gbp')) || 0,
      invoiceCount: Number(g('invoice_count')) || 0,
    };
  });
}

export interface InvoiceSupplierReport {
  created: string[];
  gapFilled: string[];
  unchanged: number;
  slugTaken: string[];
  /** Created or pre-existing, but with no email to send a PO to. Spend-ranked. */
  notOrderable: Array<{ name: string; spendGbp: number }>;
}

export async function importInvoiceSuppliers(
  opts: { dryRun?: boolean; includeReview?: boolean } = {},
): Promise<InvoiceSupplierReport> {
  const companyId = getSingletonCompanyId();
  const db = getDb();
  const dry = opts.dryRun ?? false;

  const rows = readSupplierCsv(readFileSync(join(DATA_DIR, 'suppliers.csv'), 'utf8'));
  if (opts.includeReview) {
    rows.push(...readSupplierCsv(readFileSync(join(DATA_DIR, 'suppliers-review.csv'), 'utf8')));
  }

  const report: InvoiceSupplierReport = {
    created: [],
    gapFilled: [],
    unchanged: 0,
    slugTaken: [],
    notOrderable: [],
  };

  const existing = await db.query.suppliers.findMany({
    where: eq(suppliers.companyId, companyId),
    columns: { id: true, name: true, slug: true, type: true, email: true, orderEmail: true },
  });
  // Matched case-insensitively. The catalogue import wrote "Makro" and the
  // invoices say "makro"; an exact match would make a second Makro.
  const byName = new Map(existing.map((s) => [s.name.trim().toLowerCase(), s]));
  const takenSlugs = new Set(existing.map((s) => s.slug).filter((s): s is string => !!s));

  for (const row of rows) {
    if (!row.name) continue;
    const found = byName.get(row.name.toLowerCase());

    // The slug column is uniquely indexed. A collision is not worth failing the
    // whole run over — slug is optional, and only the drop-ship connector
    // registry reads it. Record it and leave the column null.
    let slug: string | null = row.slug || null;
    if (slug && takenSlugs.has(slug) && found?.slug !== slug) {
      report.slugTaken.push(`${row.name} (${slug})`);
      slug = null;
    }

    if (found) {
      // Gap-fill only. Whatever the operator already put there stands.
      const patch: { slug?: string; type?: string } = {};
      if (!found.slug && slug) patch.slug = slug;
      if (!found.type && row.type) patch.type = row.type;
      if (Object.keys(patch).length === 0) {
        report.unchanged += 1;
      } else {
        report.gapFilled.push(row.name);
        if (!dry) {
          await db
            .update(suppliers)
            .set({ ...patch, updatedAt: new Date() })
            .where(eq(suppliers.id, found.id));
        }
      }
      if (!found.email && !found.orderEmail) {
        report.notOrderable.push({ name: row.name, spendGbp: row.spendGbp });
      }
      continue;
    }

    report.created.push(row.name);
    report.notOrderable.push({ name: row.name, spendGbp: row.spendGbp });
    if (slug) takenSlugs.add(slug);
    if (dry) continue;
    await db.insert(suppliers).values({
      companyId,
      name: row.name,
      slug,
      type: row.type || null,
      // Everything else stays at its schema default. Guessing a lead time or a
      // credit term from an invoice would be inventing the number, and a wrong
      // lead time quietly mis-times every reorder proposal for that supplier.
    });
  }

  report.notOrderable.sort((a, b) => b.spendGbp - a.spendGbp);
  return report;
}

const isCliEntry = process.argv[1]?.endsWith('import-invoice-suppliers.ts') ?? false;

if (isCliEntry) {
  const dryRun = process.argv.includes('--dry-run');
  const includeReview = process.argv.includes('--include-review');
  importInvoiceSuppliers({ dryRun, includeReview })
    .then((r) => {
      console.log(`[import-invoice-suppliers] ${dryRun ? 'DRY RUN — nothing written' : 'OK'}`);
      console.log(`  created    : ${r.created.length}`);
      console.log(`  gap-filled : ${r.gapFilled.length}  (blank slug/type only)`);
      console.log(`  unchanged  : ${r.unchanged}`);
      if (r.created.length > 0) {
        console.log(`\n  New suppliers: ${r.created.join(', ')}`);
      }
      if (r.slugTaken.length > 0) {
        console.log(`\n  Slug already in use, left blank: ${r.slugTaken.join(', ')}`);
      }
      if (r.notOrderable.length > 0) {
        const spend = r.notOrderable.reduce((t, s) => t + s.spendGbp, 0);
        console.log(
          `\n  ${r.notOrderable.length} supplier(s) have no email — a PO cannot be sent to them.`,
        );
        console.log(`  They carry GBP${spend.toFixed(2)} of stock spend between them.`);
        console.log('  Worth chasing first, by spend:');
        for (const s of r.notOrderable.slice(0, 15)) {
          console.log(`    GBP${s.spendGbp.toFixed(2).padStart(12)}  ${s.name}`);
        }
        if (r.notOrderable.length > 15) {
          console.log(`    … and ${r.notOrderable.length - 15} more`);
        }
        console.log('\n  Fill them in at https://stock.thebigbakes.com/suppliers');
      }
    })
    .catch((err) => {
      console.error(
        '[import-invoice-suppliers] FAILED:',
        err instanceof Error ? err.message : err,
      );
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}
