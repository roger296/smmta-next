/**
 * set-max-selling-price.ts — set max_selling_price as a multiple of min.
 *
 * Volume pricing slides a spool's price between its min and max. Every product
 * currently has max unset (or equal to min), which makes the slide a no-op, so
 * the ceiling has to be established before the feature does anything.
 *
 * Goes through the REST API rather than the database, like import-stocktake.ts:
 * the same validation and audit trail as the same edit typed into the admin UI,
 * rather than a second write path that only this script uses.
 *
 * SAFETY. This changes what customers are charged for small orders — doubling
 * the max doubles the price of a single roll. So:
 *   - it is a dry run unless you pass --apply,
 *   - it will not touch a product whose max is already set to something other
 *     than the min, on the assumption that figure was deliberate,
 *   - it refuses to run unfiltered unless you pass --all, because the database
 *     is shared with the Clothes Shop and any drop-ship catalogue.
 *
 * Usage:
 *   SMMTA_ADMIN_JWT=<token> npx tsx apps/api/scripts/set-max-selling-price.ts \
 *     --sku-prefix V3- --sku-prefix 3KG-
 *   # review the plan, then re-run with --apply
 *
 * Flags:
 *   --sku-prefix <s>   Only products whose stock code starts with <s>.
 *                      Repeatable. V3- and 3KG- are the filament catalogue.
 *   --manufacturer <id> Only products with this manufacturer UUID. Repeatable.
 *   --all              No filter — every product in the database. Refused
 *                      without this flag so scope is always a deliberate choice.
 *   --multiplier <n>   Max = min x n, rounded to the penny. Default 2.
 *   --apply            Actually write. Without it, nothing changes.
 *   --api <url>        Default https://api.cleverdeals.net/api/v1
 *   --force            Also overwrite a max that differs from the min. Use only
 *                      when you mean to discard hand-set ceilings.
 */

interface Product {
  id: string;
  name: string;
  stockCode: string | null;
  manufacturerId: string | null;
  minSellingPrice: string | null;
  maxSellingPrice: string | null;
}

interface Change {
  id: string;
  sku: string;
  name: string;
  min: number;
  currentMax: number | null;
  newMax: number;
}

function parseArgs(argv: string[]) {
  const out = {
    skuPrefixes: [] as string[],
    manufacturers: [] as string[],
    all: false,
    multiplier: 2,
    apply: false,
    force: false,
    api: 'https://api.cleverdeals.net/api/v1',
  };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--sku-prefix' && value) { out.skuPrefixes.push(value); i++; continue; }
    if (flag === '--manufacturer' && value) { out.manufacturers.push(value); i++; continue; }
    if (flag === '--all') { out.all = true; continue; }
    if (flag === '--apply') { out.apply = true; continue; }
    if (flag === '--force') { out.force = true; continue; }
    if (flag === '--multiplier' && value) { out.multiplier = Number(value); i++; continue; }
    if (flag === '--api' && value) { out.api = value.replace(/\/$/, ''); i++; continue; }
    if (flag === '--help' || flag === '-h') { printUsage(); process.exit(0); }
    throw new Error(`Unknown argument: ${flag}`);
  }
  if (!Number.isFinite(out.multiplier) || out.multiplier <= 0) {
    throw new Error(`--multiplier must be a positive number, got ${out.multiplier}`);
  }
  const filtered = out.skuPrefixes.length > 0 || out.manufacturers.length > 0;
  if (!filtered && !out.all) {
    printUsage();
    throw new Error(
      'Refusing to run without a filter. Pass --sku-prefix / --manufacturer, or --all to mean it.',
    );
  }
  return out;
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(
    'Usage: SMMTA_ADMIN_JWT=<token> tsx apps/api/scripts/set-max-selling-price.ts \\\n' +
      '         [--sku-prefix <s> ...] [--manufacturer <uuid> ...] [--all]\\\n' +
      '         [--multiplier 2] [--apply] [--force] [--api <url>]',
  );
}

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
      throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status}: ${body.error ?? 'unknown'}`);
    }
    return body;
  }
  return { call };
}

const money = (n: number) => `£${n.toFixed(2)}`;

export async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const token = process.env.SMMTA_ADMIN_JWT;
  if (!token) throw new Error('SMMTA_ADMIN_JWT is not set');
  const { call } = makeClient(args.api, token);

  const products: Product[] = [];
  for (let page = 1; ; page++) {
    const d = await call<{ data: Product[]; totalPages: number }>(
      `/products?pageSize=250&page=${page}`,
    );
    products.push(...d.data);
    if (page >= (d.totalPages || 1)) break;
  }
  log(`Catalogue: ${products.length} products`);

  const inScope = products.filter((p) => {
    if (args.all) return true;
    const bySku =
      args.skuPrefixes.length > 0 &&
      !!p.stockCode &&
      args.skuPrefixes.some((prefix) => p.stockCode!.startsWith(prefix));
    const byMfr = args.manufacturers.length > 0 && !!p.manufacturerId &&
      args.manufacturers.includes(p.manufacturerId);
    return bySku || byMfr;
  });
  log(`In scope:  ${inScope.length} products`);
  if (inScope.length === 0) {
    log('Nothing matched the filter — check the prefixes against the catalogue.');
    return;
  }

  const changes: Change[] = [];
  const skippedNoMin: Product[] = [];
  const skippedDeliberate: Product[] = [];
  const alreadyCorrect: Product[] = [];

  for (const p of inScope) {
    const min = p.minSellingPrice != null ? Number(p.minSellingPrice) : NaN;
    if (!Number.isFinite(min) || min <= 0) { skippedNoMin.push(p); continue; }

    const currentMax = p.maxSellingPrice != null ? Number(p.maxSellingPrice) : null;
    const newMax = Math.round(min * args.multiplier * 100) / 100;

    // A max that is neither absent nor equal to the min was set by hand. Leave
    // it alone unless explicitly told otherwise — silently overwriting an
    // operator's deliberate ceiling is the kind of thing nobody notices until
    // a customer is charged the wrong amount.
    const isUnset = currentMax === null || Math.abs(currentMax - min) < 0.005;
    if (!isUnset && !args.force) { skippedDeliberate.push(p); continue; }
    if (currentMax !== null && Math.abs(currentMax - newMax) < 0.005) {
      alreadyCorrect.push(p);
      continue;
    }
    changes.push({
      id: p.id,
      sku: p.stockCode ?? p.id,
      name: p.name,
      min,
      currentMax,
      newMax,
    });
  }

  log('');
  log(`Would change:    ${changes.length}`);
  log(`Already correct: ${alreadyCorrect.length}`);
  log(`No min price:    ${skippedNoMin.length} (skipped — nothing to multiply)`);
  log(`Hand-set max:    ${skippedDeliberate.length} (skipped — pass --force to overwrite)`);
  for (const p of skippedDeliberate) {
    log(`    ${(p.stockCode ?? p.id).padEnd(28)} min ${p.minSellingPrice} max ${p.maxSellingPrice}`);
  }

  log('');
  for (const c of changes) {
    log(
      `  ${c.sku.padEnd(28)} min ${money(c.min).padStart(8)}  ` +
        `max ${c.currentMax === null ? '(unset)'.padStart(8) : money(c.currentMax).padStart(8)}` +
        ` -> ${money(c.newMax)}`,
    );
  }

  if (!args.apply) {
    log('');
    log('DRY RUN — nothing was changed. Re-run with --apply to write these.');
    return;
  }

  log('');
  let ok = 0;
  const failures: Array<{ sku: string; error: string }> = [];
  for (const c of changes) {
    try {
      // PUT is the only update verb on this resource. Send just the field we
      // are changing; the route merges rather than replacing.
      await call(`/products/${c.id}`, {
        method: 'PUT',
        body: JSON.stringify({ maxSellingPrice: c.newMax }),
      });
      ok++;
      log(`  ok   ${c.sku.padEnd(28)} -> ${money(c.newMax)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ sku: c.sku, error: message });
      // Keep going: one bad product should not strand the rest. Re-running is
      // safe because applied products become no-ops.
      log(`  FAIL ${c.sku.padEnd(28)} ${message}`);
    }
  }

  log('');
  log(`Applied ${ok}/${changes.length}.`);
  if (failures.length) {
    log(`${failures.length} failed — re-run to retry just those:`);
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
  console.error('set-max-selling-price failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
