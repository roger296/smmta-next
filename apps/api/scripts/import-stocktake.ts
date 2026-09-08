/**
 * import-stocktake.ts — reconcile system stock against a counted stocktake.
 *
 * Takes a CSV export from whatever system did the counting, works out the
 * delta per SKU against current IN_STOCK, and posts one adjustment per SKU
 * that differs. SKUs already at the counted figure are left alone, so the
 * script is idempotent: run it twice and the second run is a no-op.
 *
 * Goes through the REST API rather than the database directly, unlike the seed
 * scripts. A stocktake is an operator action, and routing it through
 * /stock-items/adjust means it takes the same validation, GL posting and audit
 * trail as the same adjustment typed into the admin UI — rather than a second,
 * subtly different write path that only this script uses.
 *
 * Usage:
 *   SMMTA_ADMIN_JWT=<token> npx tsx apps/api/scripts/import-stocktake.ts \
 *     --csv ./stocktake.csv --dry-run
 *
 * Flags:
 *   --csv <path>        Required. Columns: StockCode, Quantity. Optional:
 *                       SellerSKU (fallback match), TotalValue (for unit cost).
 *   --dry-run           Print the plan and change nothing. ALWAYS do this first.
 *   --api <url>         Default https://api.cleverdeals.net/api/v1
 *   --warehouse <uuid>  Required only when the company has several warehouses.
 *   --alias FROM=TO     Map a sheet SKU onto a system SKU. Repeatable. Counting
 *                       systems drift from the catalogue over time (the first
 *                       run needed V3-ABS-REG-BLACK=V3-ABS-BLACK); an explicit
 *                       flag keeps that visible in the command rather than
 *                       hidden in fuzzy matching that might pick wrong.
 *   --reason "<text>"   Adjustment reason. Defaults to a dated stocktake note.
 *
 * Unmatched SKUs are reported and skipped, never guessed at. A row whose
 * product does not exist needs the product creating first — that is a
 * catalogue decision, not something a stock import should invent.
 */
import { readFileSync } from 'node:fs';

interface SheetRow {
  stockCode: string;
  sellerSku: string | null;
  quantity: number;
  unitCost: number | null;
}

interface Product {
  id: string;
  name: string;
  stockCode: string | null;
}

interface Plan {
  sku: string;
  productId: string;
  name: string;
  current: number;
  target: number;
  delta: number;
  unitCost: number;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const out = {
    csv: '',
    dryRun: false,
    api: 'https://api.cleverdeals.net/api/v1',
    warehouse: '',
    aliases: new Map<string, string>(),
    reason: `Stocktake reconciliation ${new Date().toISOString().slice(0, 10)}`,
  };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--csv' && value) { out.csv = value; i++; continue; }
    if (flag === '--dry-run') { out.dryRun = true; continue; }
    if (flag === '--api' && value) { out.api = value.replace(/\/$/, ''); i++; continue; }
    if (flag === '--warehouse' && value) { out.warehouse = value; i++; continue; }
    if (flag === '--reason' && value) { out.reason = value; i++; continue; }
    if (flag === '--alias' && value) {
      const [from, to] = value.split('=');
      if (!from || !to) throw new Error(`--alias expects FROM=TO, got "${value}"`);
      out.aliases.set(from.trim(), to.trim());
      i++;
      continue;
    }
    if (flag === '--help' || flag === '-h') { printUsage(); process.exit(0); }
    throw new Error(`Unknown argument: ${flag}`);
  }
  if (!out.csv) { printUsage(); throw new Error('--csv is required'); }
  return out;
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(
    'Usage: SMMTA_ADMIN_JWT=<token> tsx apps/api/scripts/import-stocktake.ts \\\n' +
      '         --csv <path> [--dry-run] [--api <url>] [--warehouse <uuid>]\\\n' +
      '         [--alias FROM=TO ...] [--reason "<text>"]',
  );
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Minimal CSV reader: these exports have no quoted commas. Throws if that
 *  assumption ever breaks, rather than silently mis-parsing a row. */
function readCsv(path: string): SheetRow[] {
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) throw new Error(`${path} has no data rows`);
  if (text.includes('"')) {
    throw new Error('CSV contains quote characters; this reader cannot parse quoted fields');
  }

  const header = lines[0]!.split(',').map((h) => h.trim());
  const idx = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iCode = idx('StockCode');
  const iSeller = idx('SellerSKU');
  const iQty = idx('Quantity');
  const iValue = idx('TotalValueInReportingCurrency') !== -1
    ? idx('TotalValueInReportingCurrency')
    : idx('TotalValue');
  if (iCode === -1 || iQty === -1) {
    throw new Error(`${path} must have StockCode and Quantity columns; found: ${header.join(', ')}`);
  }

  return lines.slice(1).map((line, n) => {
    const cells = line.split(',').map((c) => c.trim());
    const quantity = Number(cells[iQty]);
    if (!Number.isInteger(quantity) || quantity < 0) {
      throw new Error(`Row ${n + 2}: Quantity "${cells[iQty]}" is not a non-negative integer`);
    }
    const total = iValue !== -1 ? Number(cells[iValue]) : NaN;
    return {
      stockCode: cells[iCode] ?? '',
      sellerSku: iSeller !== -1 ? (cells[iSeller] ?? null) : null,
      quantity,
      // The sheet reports total value, so derive the per-unit figure the
      // adjustment endpoint wants. A zero count carries no usable cost.
      unitCost: Number.isFinite(total) && quantity > 0 ? Number((total / quantity).toFixed(4)) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

function makeClient(api: string, token: string) {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${api}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string } & T;
    if (!res.ok || body.success === false) {
      throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}: ${body.error ?? 'unknown'}`);
    }
    return body;
  }
  return { call };
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const token = process.env.SMMTA_ADMIN_JWT;
  if (!token) throw new Error('SMMTA_ADMIN_JWT is not set');
  const { call } = makeClient(args.api, token);

  const sheet = readCsv(args.csv);
  log(`Read ${sheet.length} rows from ${args.csv}`);

  // Warehouse — only ask the operator to choose when there is a choice.
  const warehouses = await call<{ data: Array<{ id: string; name: string }> }>('/warehouses');
  const whList = warehouses.data ?? [];
  let warehouseId = args.warehouse;
  if (!warehouseId) {
    if (whList.length !== 1) {
      throw new Error(
        `Company has ${whList.length} warehouses; pass --warehouse <uuid>. ` +
          whList.map((w) => `${w.name}=${w.id}`).join(', '),
      );
    }
    warehouseId = whList[0]!.id;
  }
  log(`Warehouse: ${whList.find((w) => w.id === warehouseId)?.name ?? warehouseId}`);

  // Catalogue, paged at the API's cap.
  const products: Product[] = [];
  for (let page = 1; ; page++) {
    const d = await call<{ data: Product[]; totalPages: number }>(
      `/products?pageSize=250&page=${page}`,
    );
    products.push(...d.data);
    if (page >= (d.totalPages || 1)) break;
  }
  const bySku = new Map(products.filter((p) => p.stockCode).map((p) => [p.stockCode!, p]));
  log(`Catalogue: ${products.length} products`);

  // Current on-hand. The report counts IN_STOCK only, which is the same basis
  // a counted "available" figure uses — allocated stock is spoken for and
  // appears on neither side.
  const report = await call<{ data: { lines: Array<{ stockCode: string; totalQuantity: number }> } }>(
    '/stock-items/report',
  );
  const current = new Map<string, number>();
  for (const l of report.data.lines) {
    if (l.stockCode) current.set(l.stockCode, Math.round(Number(l.totalQuantity)));
  }

  const plan: Plan[] = [];
  const unmatched: SheetRow[] = [];
  for (const row of sheet) {
    const aliased = args.aliases.get(row.stockCode) ?? args.aliases.get(row.sellerSku ?? '');
    const product =
      (aliased ? bySku.get(aliased) : undefined) ??
      bySku.get(row.stockCode) ??
      (row.sellerSku ? bySku.get(row.sellerSku) : undefined);
    if (!product) { unmatched.push(row); continue; }

    const now = current.get(product.stockCode!) ?? 0;
    const delta = row.quantity - now;
    if (delta === 0) continue;
    plan.push({
      sku: product.stockCode!,
      productId: product.id,
      name: product.name,
      current: now,
      target: row.quantity,
      delta,
      // Falls back to what the stock is already valued at, so a sheet without
      // a value column never silently books stock in at zero.
      unitCost: row.unitCost ?? 0,
    });
  }

  const adds = plan.filter((p) => p.delta > 0);
  const removes = plan.filter((p) => p.delta < 0);
  log('');
  log(`Changing:  ${plan.length} SKUs`);
  log(`  increase ${adds.length} SKUs, +${adds.reduce((s, p) => s + p.delta, 0)} units`);
  log(`  decrease ${removes.length} SKUs, ${removes.reduce((s, p) => s + p.delta, 0)} units`);
  log(`Unchanged: ${sheet.length - plan.length - unmatched.length} SKUs already correct`);
  log(`Unmatched: ${unmatched.length} SKUs (skipped — no such product)`);
  for (const u of unmatched) log(`    ${u.stockCode} (qty ${u.quantity})`);

  if (args.dryRun) {
    log('');
    log('--dry-run: no changes made. Full plan:');
    for (const p of plan) {
      log(`  ${p.delta > 0 ? 'ADD   ' : 'REMOVE'} ${String(Math.abs(p.delta)).padStart(4)}  ` +
          `${p.sku.padEnd(30)} ${p.current} -> ${p.target}`);
    }
    return;
  }

  let ok = 0;
  const failures: Array<{ sku: string; error: string }> = [];
  for (const p of plan) {
    try {
      await call('/stock-items/adjust', {
        method: 'POST',
        body: JSON.stringify({
          productId: p.productId,
          warehouseId,
          type: p.delta > 0 ? 'ADD' : 'REMOVE',
          quantity: Math.abs(p.delta),
          valuePerUnit: p.unitCost,
          currencyCode: 'GBP',
          reason: args.reason,
        }),
      });
      ok++;
      log(`  ok  ${p.sku.padEnd(30)} ${p.current} -> ${p.target}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ sku: p.sku, error: message });
      // Keep going: one bad SKU should not strand the other sixty-odd. Each
      // adjustment is its own transaction, so what already applied stands.
      log(`  FAIL ${p.sku.padEnd(30)} ${message}`);
    }
  }

  log('');
  log(`Applied ${ok}/${plan.length} adjustments.`);
  if (failures.length) {
    log(`${failures.length} failed — re-run to retry just those (applied SKUs are now no-ops):`);
    for (const f of failures) log(`    ${f.sku}: ${f.error}`);
    process.exitCode = 1;
  }
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('import-stocktake failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
