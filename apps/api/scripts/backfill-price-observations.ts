/**
 * Back-fill supplier price history from BumbleBee's OCR'd invoices
 * (supplier-ordering groundwork, docs/plans/SUPPLIER_ORDERING_PLAN.md §3.3).
 *
 * Every invoice line whose supplier code resolves to exactly ONE buying option
 * becomes an INVOICE price observation: what we actually paid, when, for which
 * venue. Re-runnable — each line has a deterministic key, so running it again
 * on a newer capture adds only the new lines. Until BumbleBee exposes invoice
 * lines as a paged feed, this is how the history stays current: re-capture,
 * re-run.
 *
 * Read-only unless --apply.
 *
 *   npx tsx scripts/backfill-price-observations.ts [capture.json] [--apply]
 *
 * The capture defaults to data/invoice-skus/bumblebee-purchase-lines.json and
 * must record `capture.cap_checked` — the source tool truncates at 500 rows
 * without saying so (DECISIONS.md §F20).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeDatabase } from '../src/config/database.js';
import type { InvoiceLine } from '../src/modules/suppliers/invoice-sku-extract.js';
import { backfillFromInvoices } from '../src/modules/suppliers/price-observations.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const src =
  args.find((a) => !a.startsWith('--')) ??
  join(import.meta.dirname, '..', 'data', 'invoice-skus', 'bumblebee-purchase-lines.json');

const payload = JSON.parse(readFileSync(src, 'utf8')) as {
  capture?: { cap_checked?: boolean; date_from?: string; date_to?: string };
  rows: InvoiceLine[];
};
if (!payload.capture?.cap_checked) {
  console.error(`${src} does not record capture.cap_checked — refusing to read prices from it.`);
  process.exit(1);
}

const r = await backfillFromInvoices(payload.rows, { apply });
const pad = (s: string | number, n: number) => String(s).padEnd(n);

console.log(`[backfill-price-observations] ${apply ? 'APPLY' : 'DRY RUN — nothing written'}`);
console.log(`  capture: ${src} (${payload.capture.date_from} → ${payload.capture.date_to})`);
console.log(`  invoice lines:          ${r.lines}`);
console.log(`  priced to one option:   ${r.resolved}`);
if (apply) {
  console.log(`  written:                ${r.inserted}`);
  console.log(`  already recorded:       ${r.alreadyRecorded}`);
}
console.log('  skipped:');
for (const [reason, n] of Object.entries(r.skipped)) if (n) console.log(`    ${pad(reason, 24)}${n}`);
console.log('  by supplier (lines → priced):');
for (const [name, t] of Object.entries(r.bySupplier).sort((a, b) => b[1].lines - a[1].lines)) {
  console.log(`    ${pad(name || '(blank)', 24)}${pad(t.lines, 7)}→ ${t.resolved}`);
}
if (r.ambiguousCodes.length) {
  console.log(`  codes on several buying options (price not attributed): ${r.ambiguousCodes.length}`);
  for (const a of r.ambiguousCodes.slice(0, 10)) console.log(`    ${a.supplier} ${a.sku} → ${a.mappings} options`);
}
if (r.unmappedCodes.length) {
  console.log(`  codes with no mapping: ${r.unmappedCodes.length} (busiest first)`);
  for (const u of r.unmappedCodes.slice(0, 15)) console.log(`    ${pad(u.lines, 5)}${u.supplier} ${u.sku}  ${u.description}`);
}
if (!apply) console.log('\n  Re-run with --apply to write.');
await closeDatabase();
